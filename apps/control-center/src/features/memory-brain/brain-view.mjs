const TAU = Math.PI * 2;
const AMBIENT_GROUP_IDLE_MIN_DURATION = 520;
const AMBIENT_GROUP_IDLE_MAX_DURATION = 1_900;
const AMBIENT_NODE_START_MAX_DELAY = 1_350;
const AMBIENT_NODE_MIN_DURATION = 430;
const AMBIENT_NODE_MAX_DURATION = 1_260;
// 脑内坐标单位 / 毫秒；所有脉冲按同一速度走完整条真实连线。
const SIGNAL_TRAVEL_SPEED = 0.0005;
const FOCUSED_GROUP_IDLE_MIN_DURATION = 620;
const FOCUSED_GROUP_IDLE_MAX_DURATION = 1_600;
const FOCUSED_NODE_START_MAX_DELAY = 850;
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

function relationColor(_edge, alpha) {
  // 语义颜色只归节点所有；边复用普通 event 节点的默认色，不另起一套色值。
  return `rgba(220, 246, 255, ${alpha})`;
}

function nodePalette(node) {
  if (node.visualTier === "major") {
    return ({
      episode: "87, 239, 210",
      topic: "177, 151, 255",
      user: "105, 218, 242",
      agent: "177, 151, 255",
      relationship: "255, 142, 180",
      entity: "151, 207, 255",
    }[node.visualFamily] || "177, 151, 255");
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
    const memberWeight = clamp(Math.log2(1 + Number(node.memberCount || 0)) / 4, 0, 1);
    return 1.7 + importance * 0.2 + memberWeight * 0.1;
  }
  // 原文证据（utterance）默认不进入大脑画面；在展开时保留最小一层。
  if (node.kind === "utterance") return 0.5 + importance * 0.3;
  return 1.3 + importance * 0.3;
}

export function memoryBrainEdgeMode(edge, {
  selectedId = "",
  ambientStrength = 0,
} = {}) {
  if (selectedId && (edge?.source === selectedId || edge?.target === selectedId)) {
    return "direct";
  }
  // 一条原本属于结构骨架的边也可以在随机放电时被激活；否则它只会静态显示，
  // 无法由节点亮起带动脉冲。
  if (!selectedId && Number(ambientStrength) > 0) return "ambient";
  // 默认状态保留结构骨架。此前只有轮播到的少量环境连线会短暂出现，
  // 即使数据库里已经有主题、我、Agent、关系的真实归属边，画面也像没有线。
  if (!selectedId && edge?.structural) return "structural";
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

function edgeSignalDuration(source, target) {
  if (!source?.position || !target?.position) return 1;
  return Math.max(1, Math.round(Math.sqrt(squaredDistance(source.position, target.position)) / SIGNAL_TRAVEL_SPEED));
}

function hashUnit(value, salt = "") {
  return stableHash(`${salt}\u001f${value}`) / 0xffff_ffff;
}

function evidenceStarPosition(parent, source, index, total) {
  const sourceId = String(source?.id || source?.external_id || index);
  const count = Math.max(1, total);
  const angle = (index / count) * TAU + hashUnit(sourceId, "evidence-angle") * 0.82;
  const layer = Math.floor(index / 7);
  const radius = 0.15 + layer * 0.08 + hashUnit(sourceId, "evidence-radius") * 0.08;
  const vertical = (hashUnit(sourceId, "evidence-y") - 0.5) * 0.32;
  const depth = (hashUnit(sourceId, "evidence-z") - 0.5) * 0.28;
  return {
    x: parent.x + Math.cos(angle) * radius,
    y: parent.y + Math.sin(angle) * radius * 0.74 + vertical,
    z: parent.z + depth,
  };
}

function createEvidenceStars(parent, sources) {
  const uniqueSources = [...new Map((Array.isArray(sources) ? sources : [])
    .filter((source) => source && typeof source === "object")
    .map((source, index) => [String(source.id || source.external_id || `source-${index}`), source]))
    .values()];
  return uniqueSources.map((source, index) => ({
    id: `evidence:${String(source.id || source.external_id || index)}`,
    source,
    position: evidenceStarPosition(parent, source, index, uniqueSources.length),
    radius: 0.5 + clamp(Number(source.evidence_strength) || 0, 0, 1) * 0.3,
  }));
}

function evidenceTwinkle(evidenceId, time) {
  const duration = 3_800 + hashUnit(evidenceId, "evidence-twinkle-duration") * 3_400;
  const phase = hashUnit(evidenceId, "evidence-twinkle-phase") * TAU;
  // 每颗证据星只做缓慢、错相的呼吸，不再周期性突然炸出一层光圈。
  return Math.pow((Math.sin(time / duration * TAU + phase) + 1) * 0.5, 1.45);
}

function randomInteger(minimum, maximum) {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInteger(0, index);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function ambientPulse(groupAge, activityOrActivities) {
  const activities = Array.isArray(activityOrActivities)
    ? activityOrActivities
    : activityOrActivities ? [activityOrActivities] : [];
  let strongest = { progress: 0, strength: 0 };
  for (const activity of activities) {
    const elapsed = groupAge - activity.start;
    if (elapsed <= 0 || elapsed >= activity.duration) continue;
    const progress = elapsed / activity.duration;
    const strength = Math.pow(Math.sin(progress * Math.PI), 1.45);
    if (strength > strongest.strength) strongest = { progress, strength };
  }
  return strongest;
}

function createAmbientGroup(nodes, adjacency, nodeById, groupIndex) {
  const candidates = nodes.filter((node) => node.position && (adjacency.get(node.id)?.length || 0) > 0);
  const fallbackCandidates = candidates.length ? candidates : nodes.filter((node) => node.position);
  const groupSize = Math.min(
    fallbackCandidates.length,
    randomInteger(3, Math.min(6, Math.max(3, Math.ceil(Math.sqrt(fallbackCandidates.length)) + 2))),
  );
  const selected = [];
  while (selected.length < groupSize) {
    let choice = null;
    // 从一小组随机候选中优先选彼此有距离的点：活动仍是随机的，
    // 但不会每次都挤在同一个小区域里闪。
    for (const candidate of shuffle(fallbackCandidates).slice(0, Math.min(8, fallbackCandidates.length))) {
      if (selected.includes(candidate)) continue;
      const separation = selected.length
        ? Math.min(...selected.map((node) => squaredDistance(candidate.position, node.position)))
        : 0;
      const score = Math.random() * 0.86 + (selected.length ? Math.min(1, separation / 4) * 0.34 : 0);
      if (!choice || score > choice.score) choice = { node: candidate, score };
    }
    if (!choice) break;
    selected.push(choice.node);
  }

  const edgeIndices = new Set();
  const nodeIds = new Set(selected.map((node) => node.id));
  const nodeActivities = new Map();
  const addNodeActivity = (nodeId, activity) => {
    const activities = nodeActivities.get(nodeId) || [];
    activities.push(activity);
    nodeActivities.set(nodeId, activities);
  };
  for (const node of selected) {
    addNodeActivity(node.id, {
      start: randomInteger(0, AMBIENT_NODE_START_MAX_DELAY),
      duration: randomInteger(AMBIENT_NODE_MIN_DURATION, AMBIENT_NODE_MAX_DURATION),
    });
  }
  const edgeActivities = new Map();
  for (const node of selected) {
    const nodeActivity = nodeActivities.get(node.id)?.[0];
    const connected = shuffle(adjacency.get(node.id) || []);
    const edgeCount = Math.min(connected.length, randomInteger(1, Math.min(3, Math.max(1, connected.length))));
    for (const connection of connected.slice(0, edgeCount)) {
      if (edgeIndices.has(connection.index)) continue;
      edgeIndices.add(connection.index);
      const duration = edgeSignalDuration(node, nodeById.get(connection.neighborId));
      const start = nodeActivity.start + randomInteger(90, 360);
      // 方向由正在放电的节点决定：信号从它沿真实相邻边传向另一端，
      // 不再随机反向穿过整条线。
      const direction = connection.edge.source === node.id ? 1 : -1;
      edgeActivities.set(connection.index, {
        start,
        duration,
        direction,
        tailLength: randomInteger(82, 132) / 1_000,
      });
      nodeIds.add(connection.neighborId);
      // 信号接近另一端时，邻近节点才亮起；同一节点可接收多次活动。
      addNodeActivity(connection.neighborId, {
        start: start + Math.round(duration * randomInteger(72, 88) / 100),
        duration: randomInteger(AMBIENT_NODE_MIN_DURATION, AMBIENT_NODE_MAX_DURATION),
      });
    }
  }
  const latestPulseEnd = Math.max(
    0,
    ...[...nodeActivities.values()].flat().map((activity) => activity.start + activity.duration),
    ...[...edgeActivities.values()].map((activity) => activity.start + activity.duration),
  );
  return {
    nodeIds,
    edgeIndices,
    nodeActivities,
    edgeActivities,
    duration: latestPulseEnd + randomInteger(AMBIENT_GROUP_IDLE_MIN_DURATION, AMBIENT_GROUP_IDLE_MAX_DURATION),
    index: groupIndex,
  };
}

function createFocusedGroup(selectedId, adjacency, nodeById, groupIndex) {
  const connected = shuffle(adjacency.get(selectedId) || []);
  const nodeIds = new Set([selectedId]);
  const nodeActivities = new Map();
  const addNodeActivity = (nodeId, activity) => {
    const activities = nodeActivities.get(nodeId) || [];
    activities.push(activity);
    nodeActivities.set(nodeId, activities);
  };
  const sourceActivity = {
    start: randomInteger(80, FOCUSED_NODE_START_MAX_DELAY),
    duration: randomInteger(AMBIENT_NODE_MIN_DURATION, AMBIENT_NODE_MAX_DURATION),
  };
  addNodeActivity(selectedId, sourceActivity);
  const edgeActivities = new Map();
  const edgeCount = Math.min(connected.length, randomInteger(1, Math.min(3, Math.max(1, connected.length))));
  for (const connection of connected.slice(0, edgeCount)) {
    const duration = edgeSignalDuration(nodeById.get(selectedId), nodeById.get(connection.neighborId));
    const start = sourceActivity.start + randomInteger(90, 260);
    edgeActivities.set(connection.index, {
      start,
      duration,
      direction: connection.edge.source === selectedId ? 1 : -1,
      tailLength: randomInteger(74, 118) / 1_000,
    });
    nodeIds.add(connection.neighborId);
    addNodeActivity(connection.neighborId, {
      start: start + Math.round(duration * randomInteger(74, 90) / 100),
      duration: randomInteger(AMBIENT_NODE_MIN_DURATION, AMBIENT_NODE_MAX_DURATION),
    });
  }
  const latestPulseEnd = Math.max(
    0,
    ...[...nodeActivities.values()].flat().map((activity) => activity.start + activity.duration),
    ...[...edgeActivities.values()].map((activity) => activity.start + activity.duration),
  );
  return {
    nodeIds,
    edgeIndices: new Set(edgeActivities.keys()),
    nodeActivities,
    edgeActivities,
    duration: latestPulseEnd + randomInteger(FOCUSED_GROUP_IDLE_MIN_DURATION, FOCUSED_GROUP_IDLE_MAX_DURATION),
    index: groupIndex,
  };
}

export function createMemoryBrainView(canvas, graph, {
  onSelect = () => {},
  onSelectEvidence = () => {},
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
  let selectedEvidenceId = "";
  let directIds = new Set();
  let evidenceStars = [];
  let hitTargets = [];
  let pointerDown = null;
  let destroyed = false;
  let frame = 0;
  let lastInteractionAt = performance.now();
  let ambientGroup = createAmbientGroup(nodes, adjacency, nodeById, 0);
  let ambientGroupAge = 0;
  let focusedGroup = null;
  let focusedGroupAge = 0;
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
    if (reducedMotion) {
      lastAmbientFrameAt = time;
      return;
    }
    const elapsed = Math.min(80, Math.max(0, time - lastAmbientFrameAt));
    lastAmbientFrameAt = time;
    if (selectedId) {
      if (!focusedGroup) focusedGroup = createFocusedGroup(selectedId, adjacency, nodeById, 0);
      focusedGroupAge += elapsed;
      if (focusedGroupAge >= focusedGroup.duration) {
        focusedGroupAge = 0;
        focusedGroup = createFocusedGroup(selectedId, adjacency, nodeById, focusedGroup.index + 1);
      }
      return;
    }
    ambientGroupAge += elapsed;
    if (ambientGroupAge >= ambientGroup.duration) {
      // 每一组的节点起点、放电时长、边脉冲和静默时间都重新抽样，
      // 不保留循环相位，避免形成可以预期的节奏。
      ambientGroupAge = 0;
      ambientGroup = createAmbientGroup(nodes, adjacency, nodeById, ambientGroup.index + 1);
    }
  }

  function ambientActivityFor(nodeOrEdgeId, kind) {
    if (reducedMotion) return { progress: 0, strength: 0, direction: 1, tailLength: 0 };
    const group = selectedId ? focusedGroup : ambientGroup;
    if (!group) return { progress: 0, strength: 0, direction: 1, tailLength: 0 };
    const collection = kind === "edge" ? group.edgeIndices : group.nodeIds;
    const activities = kind === "edge" ? group.edgeActivities : group.nodeActivities;
    const activity = activities.get(nodeOrEdgeId);
    const pulse = collection.has(nodeOrEdgeId)
      ? ambientPulse(selectedId ? focusedGroupAge : ambientGroupAge, activity)
      : { progress: 0, strength: 0 };
    return {
      ...pulse,
      direction: kind === "edge" ? (activity?.direction || 1) : 1,
      tailLength: kind === "edge" ? (activity?.tailLength || 0.1) : 0,
    };
  }

  function quadraticPoint(start, control, end, progress) {
    const inverse = 1 - progress;
    return {
      x: inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x,
      y: inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y,
    };
  }

  function drawSignalTail(projected, activity) {
    if (activity.strength <= 0) return;
    const headProgress = activity.direction < 0 ? 1 - activity.progress : activity.progress;
    const tailLength = activity.tailLength || 0.1;
    const tailProgress = activity.direction < 0
      ? Math.min(1, headProgress + tailLength)
      : Math.max(0, headProgress - tailLength);
    const segmentCount = 18;
    const strokePulse = (widthMultiplier, alphaMultiplier, shadowBlur = 0) => {
      context.shadowColor = shadowBlur ? "rgba(232, 248, 255, .8)" : "transparent";
      context.shadowBlur = shadowBlur;
      for (let segment = 1; segment <= segmentCount; segment += 1) {
        const from = (segment - 1) / segmentCount;
        const to = segment / segmentCount;
        const center = (from + to) * 0.5;
        // 两端压回原线宽，中间局部膨起；前端略亮、后端渐隐，像管道里的信号而非一颗珠子。
        const envelope = Math.pow(Math.sin(center * Math.PI), 0.72) * (0.5 + center * 0.5);
        const startProgress = tailProgress + (headProgress - tailProgress) * from;
        const endProgress = tailProgress + (headProgress - tailProgress) * to;
        const start = quadraticPoint(projected.start, projected.control, projected.end, startProgress);
        const end = quadraticPoint(projected.start, projected.control, projected.end, endProgress);
        context.lineWidth = 0.42 + activity.strength * envelope * widthMultiplier;
        context.strokeStyle = `rgba(248, 253, 255, ${activity.strength * envelope * alphaMultiplier})`;
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
    };
    context.save();
    context.lineCap = "butt";
    // 这两层都贴着原有连线绘制：外层是局部的管壁膨胀，内层是白色信号芯。
    strokePulse(1.22, 0.17, 4 + activity.strength * 3);
    strokePulse(0.62, 0.62);
    context.restore();
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

  function drawConnections() {
    context.save();
    // 纤维重叠不能彼此相加烧成白色，否则汇聚的大神经元会被线盖住。
    context.globalCompositeOperation = "source-over";
    const visibleEdgeIndices = selectedId
      ? new Set((adjacency.get(selectedId) || []).map((connection) => connection.index))
      : new Set([
        ...edges.map((edge, index) => (edge?.structural ? index : -1)).filter((index) => index >= 0),
        ...ambientGroup.edgeIndices,
      ]);
    for (const edgeIndex of visibleEdgeIndices) {
      const edge = edges[edgeIndex];
      if (!edge) continue;
      const ambientActivity = ambientActivityFor(edgeIndex, "edge");
      const ambientStrength = ambientActivity.strength;
      const mode = memoryBrainEdgeMode(edge, { selectedId, ambientStrength });
      if (mode === "hidden") continue;
      const direct = mode === "direct";
      const ambient = mode === "ambient";
      const structural = mode === "structural";
      const projected = edgeProjection(edge);
      if (!projected) continue;
      const alpha = direct ? 0.78 : structural ? 0.17 : 0.075 + ambientStrength * 0.2;
      context.lineWidth = direct ? 1.48 : structural ? 0.8 : 0.62 + ambientStrength * 0.22;
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
      // 选中时保留稳定的关系线；只有环境活动才产生一次由源节点传向邻点的短尾迹。
      if (ambientStrength > 0 && (ambient || direct)) drawSignalTail(projected, ambientActivity);
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
    // 节点正常覆盖在纤维之上，保留自己的分类色而不是与底下白线混成白点。
    context.globalCompositeOperation = "source-over";
    for (const value of projectedNodes) {
      const { node, projected } = value;
      const selected = node.id === selectedId;
      const direct = directIds.has(node.id);
      const depth = clamp((projected.z + 1.2) / 2.4, 0, 1);
      const ambientStrength = ambientActivityFor(node.id, "node").strength;
      const ambient = ambientStrength > 0;
      const baseSize = nodeBaseRadius(node);
      const breathing = ambient
        ? 0.98 + ambientStrength * 0.12
        : 1;
      const radius = (selected ? baseSize * 1.72 : direct ? baseSize * 1.3 : baseSize)
        * breathing
        * clamp(projected.scale / 150, 0.76, 1.34);
      let alpha = (
        node.visualTier === "minor"
          ? 0.56
          : node.visualTier === "major"
            ? 0.58
            : 0.48
      ) + depth * 0.3;
      let color = nodePalette(node);
      if (selected) {
        alpha = 1;
        color = "232, 255, 249";
      } else if (direct) {
        alpha = ambient ? Math.min(1, 0.96 + ambientStrength * 0.04) : 0.96;
      } else if (selectedId) {
        alpha *= ambient ? 0.56 + ambientStrength * 0.28 : 0.2;
      } else if (ambient) {
        alpha = Math.min(1, alpha + 0.1 + ambientStrength * 0.24);
      }
      if (node.visualTier === "major" && !selected) {
        alpha = Math.max(alpha, 0.96);
      }
      if (ambient) {
        context.fillStyle = `rgba(${color}, ${0.025 + ambientStrength * 0.045})`;
        context.shadowColor = `rgba(${color}, 0.7)`;
        context.shadowBlur = 13 + ambientStrength * 9;
        context.beginPath();
        context.arc(projected.x, projected.y, Math.max(2.8, radius + 2.7), 0, TAU);
        context.fill();
      }
      if (node.visualTier === "major") {
        context.strokeStyle = `rgba(${color}, ${selectedId && !selected && !direct ? 0.07 : 0.29 + depth * 0.17})`;
        context.lineWidth = 0.8;
        context.beginPath();
        context.arc(projected.x, projected.y, radius + 2.55, 0, TAU);
        context.stroke();
        context.strokeStyle = `rgba(${color}, ${selectedId && !selected && !direct ? 0.035 : 0.15 + depth * 0.1})`;
        context.beginPath();
        context.arc(projected.x, projected.y, radius + 4.6, 0, TAU);
        context.stroke();
      } else if (node.visualTier === "state") {
        context.strokeStyle = `rgba(${color}, ${selectedId && !selected && !direct ? 0.05 : 0.22})`;
        context.lineWidth = 0.65;
        context.beginPath();
        context.arc(projected.x, projected.y, radius + 2.2, 0, TAU);
        context.stroke();
      }
      context.fillStyle = `rgba(${color}, ${alpha})`;
      context.shadowColor = `rgba(${color}, ${selected || direct ? 0.95 : node.visualTier === "minor" ? 0.58 : node.visualTier === "major" ? 0.54 : 0.4})`;
      context.shadowBlur = selected ? 25 : direct ? 16 : ambient ? 13 : node.visualTier === "minor" ? 5 : node.visualTier === "major" ? 9 : 7;
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
        kind: "node",
        id: node.id,
        x: projected.x,
        y: projected.y,
        radius: Math.max(node.visualTier === "major" ? 14 : node.visualTier === "state" ? 10 : 7, radius + 5),
        z: projected.z,
      });
    }
    context.restore();
  }

  function drawEvidenceStars(time) {
    if (!selectedId || !evidenceStars.length) return;
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const evidence of evidenceStars) {
      const projected = project(evidence.position);
      if (!projected.visible) continue;
      const selected = evidence.id === selectedEvidenceId;
      const twinkle = reducedMotion ? 0 : evidenceTwinkle(evidence.id, time);
      const radius = Math.max(1.15, evidence.radius * clamp(projected.scale / 150, 0.76, 1.34));
      const glowRadius = selected ? radius + 7.5 : radius + 3.5;
      context.fillStyle = `rgba(232, 251, 255, ${selected ? 0.25 : 0.035 + twinkle * 0.055})`;
      context.shadowColor = selected ? "rgba(173, 240, 255, .98)" : "rgba(157, 220, 255, .82)";
      context.shadowBlur = selected ? 17 : 4 + twinkle * 4;
      context.beginPath();
      context.arc(projected.x, projected.y, glowRadius, 0, TAU);
      context.fill();
      context.shadowBlur = 0;
      context.fillStyle = selected
        ? "rgba(250, 255, 255, 1)"
        : `rgba(222, 247, 255, ${0.38 + twinkle * 0.58})`;
      context.beginPath();
      context.moveTo(projected.x, projected.y - radius * 2.7);
      context.lineTo(projected.x + radius * 0.78, projected.y - radius * 0.78);
      context.lineTo(projected.x + radius * 2.7, projected.y);
      context.lineTo(projected.x + radius * 0.78, projected.y + radius * 0.78);
      context.lineTo(projected.x, projected.y + radius * 2.7);
      context.lineTo(projected.x - radius * 0.78, projected.y + radius * 0.78);
      context.lineTo(projected.x - radius * 2.7, projected.y);
      context.lineTo(projected.x - radius * 0.78, projected.y - radius * 0.78);
      context.closePath();
      context.fill();
      hitTargets.push({
        kind: "evidence",
        id: evidence.id,
        source: evidence.source,
        x: projected.x,
        y: projected.y,
        radius: Math.max(7, radius + 4.8),
        z: projected.z + 0.001,
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
    focusedGroup = null;
    focusedGroupAge = 0;
    selectedEvidenceId = "";
    evidenceStars = [];
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
    focusedGroup = null;
    focusedGroupAge = 0;
    selectedEvidenceId = "";
    directIds = new Set();
    evidenceStars = [];
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
      if (target?.kind === "evidence") {
        selectedEvidenceId = target.id;
        onSelectEvidence(target.source);
      } else if (target) {
        focusNode(target.id);
      }
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
    drawConnections();
    drawNodes(time);
    drawEvidenceStars(time);
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
    setEvidenceSources(memoryId, sources) {
      const node = nodeById.get(memoryId);
      if (!node?.position || selectedId !== memoryId) return false;
      selectedEvidenceId = "";
      evidenceStars = createEvidenceStars(node.position, sources);
      return evidenceStars.length > 0;
    },
    reset,
    selectedId: () => selectedId,
  };
}
