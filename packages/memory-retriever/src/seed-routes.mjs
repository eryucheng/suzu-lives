import { lexicalScore } from "./query.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function unit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function memoryAllowed(node, intent) {
  if (intent === "utterance") return node.kind === "utterance";
  // Raw dialogue is evidence, not the default answer surface. Keeping it out
  // of ordinary seed competition prevents a long verbatim excerpt from
  // beating the reviewed event/state that it supports. Explicit original-
  // wording requests still use the dedicated `utterance` intent above.
  if (node.kind === "utterance") return false;
  if (intent === "event") return node.kind !== "reflection";
  return true;
}

function actorEquals(actor, target) {
  return actor?.actor_role === target.role && actor?.actor_key === target.key;
}

function primaryEquals(node, target) {
  return node.subject_role === target.role && node.subject_key === target.key;
}

function stateNode(node) {
  return !["", "not_applicable", "unspecified"].includes(clean(node.state_family));
}

export function buildSubjectConstraint({
  subjectQuery,
  nodes,
  actorRolesByMemory = new Map(),
}) {
  const routeByMemory = new Map();
  const hardExcludedMemoryIds = new Set();
  if (!subjectQuery?.matched) {
    return { subjectQuery, routeByMemory, hardExcludedMemoryIds };
  }
  for (const node of nodes) {
    const roles = actorRolesByMemory.get(node.id) || [];
    let matched = false;
    let strength = "";
    if (subjectQuery.mode === "shared") {
      const memberMatches = (subjectQuery.members || []).map((member) => (
        primaryEquals(node, member) || roles.some((actor) => actorEquals(actor, member))
      ));
      matched = node.subject_role === "shared" || (
        memberMatches.length >= 2 && memberMatches.every(Boolean)
      );
      strength = node.subject_role === "shared" ? "exact-holder" : "shared-participants";
    } else {
      const target = { role: subjectQuery.role, key: subjectQuery.key };
      if (stateNode(node)) {
        matched = primaryEquals(node, target);
        strength = "exact-holder";
      } else if (node.kind === "utterance") {
        matched = primaryEquals(node, target) || roles.some((actor) => (
          actor.role === "speaker" && actorEquals(actor, target)
        ));
        strength = "exact-speaker";
      } else if (subjectQuery.focus === "state") {
        matched = primaryEquals(node, target);
        strength = "primary-subject";
      } else {
        matched = primaryEquals(node, target) || roles.some((actor) => actorEquals(actor, target));
        strength = primaryEquals(node, target) ? "primary-subject" : "structured-participant";
      }
      if (!matched && (
        stateNode(node)
        || node.kind === "utterance"
        || subjectQuery.focus === "state"
      )) {
        const hasKnownOwner = clean(node.subject_role)
          && !["unknown", "world"].includes(clean(node.subject_role))
          && clean(node.subject_key);
        if (subjectQuery.focus === "state" || hasKnownOwner) {
          hardExcludedMemoryIds.add(node.id);
        }
      }
    }
    if (!matched) continue;
    routeByMemory.set(node.id, {
      route: "subject",
      strength,
      independentlyAdmissible: false,
      rawScore: 1,
      normalizedScore: 1,
      contribution: 0,
    });
  }
  return { subjectQuery, routeByMemory, hardExcludedMemoryIds };
}

export function applySubjectConstraint(candidates, constraint) {
  const rejectedMemoryIds = [];
  const values = [];
  for (const candidate of candidates) {
    if (constraint.hardExcludedMemoryIds.has(candidate.node.id)) {
      rejectedMemoryIds.push(candidate.node.id);
      continue;
    }
    const subjectRoute = constraint.routeByMemory.get(candidate.node.id);
    if (!subjectRoute) {
      values.push(candidate);
      continue;
    }
    values.push({
      ...candidate,
      routeMatches: [...(candidate.routeMatches || []), subjectRoute],
      routeContributions: {
        ...(candidate.routeContributions || {}),
        subject: 0,
      },
    });
  }
  return { candidates: values, rejectedMemoryIds };
}

function lexicalRoute(lexical, options) {
  const magnitude = Math.min(
    1,
    lexical.score / Math.max(1, Number(options.strongLexicalScore) * 3),
  );
  const coverage = lexical.overlap / Math.max(1, lexical.queryTerms.length);
  const contribution = magnitude * 0.35
    + Math.min(1, coverage) * 0.2
    + (lexical.exactPhrase ? 0.25 : 0);
  const independentlyAdmissible = lexical.exactPhrase || (
    lexical.score >= Number(options.strongLexicalScore)
    && lexical.overlap >= 2
  );
  if (!lexical.overlap && !lexical.exactPhrase) return null;
  return {
    route: "lexical",
    strength: lexical.exactPhrase
      ? "exact"
      : independentlyAdmissible ? "strong" : "supporting",
    independentlyAdmissible,
    rawScore: lexical.score,
    normalizedScore: unit(contribution / 0.8),
    contribution,
    overlap: lexical.overlap,
    exactPhrase: lexical.exactPhrase,
    matchedTerms: lexical.matchedTerms || [],
  };
}

function vectorRoute(similarity, options) {
  if (!Number.isFinite(similarity) || similarity < Number(options.minimumVectorSimilarity)) {
    return null;
  }
  const contribution = unit((similarity - 0.25) / 0.55) * 0.4;
  const independentlyAdmissible = similarity >= Number(options.strongVectorSimilarity);
  return {
    route: "vector",
    strength: independentlyAdmissible ? "strong" : "supporting",
    independentlyAdmissible,
    rawScore: similarity,
    normalizedScore: unit(contribution / 0.4),
    contribution,
  };
}

function entityRoute(score) {
  if (!(Number(score) > 0)) return null;
  const contribution = unit(score) * 0.35;
  return {
    route: "entity",
    strength: "exact",
    independentlyAdmissible: true,
    rawScore: Number(score),
    normalizedScore: unit(score),
    contribution,
  };
}

function isCurrentStructuredState(node) {
  return stateNode(node)
    && clean(node.temporal_state) === "current"
    && clean(node.status) === "active"
    && clean(node.subject_role)
    && clean(node.subject_key)
    && clean(node.canonical_key)
    && !["", "unspecified"].includes(clean(node.representation_layer));
}

function priorContribution(node, intent, query, asksForHistoricalState, querySubject) {
  let contribution = Math.min(0.05, Math.max(0, Number(node.importance)) * 0.05);
  if (intent === "event" && node.kind !== "utterance") contribution += 0.08;
  if (intent === "event" && node.kind === "event" && node.event_date) contribution += 0.08;
  if (intent === "utterance" && node.kind === "utterance") contribution += 0.08;
  if (intent === "evidence" && node.kind !== "utterance") contribution += 0.08;
  if (
    intent === "auto"
    && querySubject?.matched
    && querySubject.mode === "personal"
    && isCurrentStructuredState(node)
  ) contribution += 0.1;
  if (node.status === "active") contribution += 0.08;
  else if (!asksForHistoricalState(query)) contribution -= 0.12;
  return contribution;
}

export function buildOrdinarySeedCandidates({
  nodes,
  query,
  intent,
  vectorScores = new Map(),
  entityScores = new Map(),
  options,
  includeWeakLexical = false,
  asksForHistoricalState = () => false,
  querySubject = null,
  accessibilityAdjustments = new Map(),
  affectiveAdjustments = new Map(),
}) {
  const values = [];
  for (const node of nodes) {
    if (!memoryAllowed(node, intent)) continue;
    const lexical = lexicalScore(
      query,
      [node.event_date || "", node.title || "", node.content].filter(Boolean).join("\n"),
    );
    const similarity = vectorScores.get(node.id) ?? Number.NEGATIVE_INFINITY;
    const entityScore = entityScores.get(node.id) || 0;
    const routeMatches = [
      lexicalRoute(lexical, options),
      vectorRoute(similarity, options),
      entityRoute(entityScore),
    ].filter(Boolean);
    const independentRoutes = routeMatches.filter((route) => route.independentlyAdmissible);
    const lexicalMatch = routeMatches.find((route) => route.route === "lexical");
    const vectorMatch = routeMatches.find((route) => route.route === "vector");
    const corroborated = Boolean(
      lexicalMatch
      && vectorMatch
      && lexical.score >= Number(options.minimumLexicalScore)
      && lexical.overlap > 0
      && similarity >= Number(options.minimumVectorSimilarity),
    );
    const convergenceOnly = !independentRoutes.length
      && !corroborated
      && includeWeakLexical
      && lexical.overlap > 0;
    if (!independentRoutes.length && !corroborated && !convergenceOnly) continue;
    const prior = priorContribution(
      node,
      intent,
      query,
      asksForHistoricalState,
      querySubject,
    );
    const baseScore = routeMatches.reduce((sum, route) => sum + route.contribution, 0) + prior;
    const accessibility = accessibilityAdjustments.get(node.id) || null;
    const accessibilityAdjustment = Number(accessibility?.scoreAdjustment || 0);
    const affectiveBias = affectiveAdjustments.get(node.id) || null;
    const affectiveAdjustment = Number(affectiveBias?.scoreAdjustment || 0);
    const score = Math.max(0, baseScore + accessibilityAdjustment + affectiveAdjustment);
    values.push({
      node,
      lexical,
      similarity,
      entityScore,
      score,
      baseScore,
      accessibility,
      affectiveBias,
      admission: independentRoutes.length
        ? "independent"
        : corroborated ? "corroborated" : "convergence-only",
      routeMatches,
      routeContributions: Object.fromEntries([
        ...routeMatches.map((route) => [route.route, route.contribution]),
        ["prior", prior],
        ["accessibility", accessibilityAdjustment],
        ["affective", affectiveAdjustment],
      ]),
    });
  }
  return values.sort((left, right) => (
    right.score - left.score
    || right.node.importance - left.node.importance
    || Date.parse(right.node.recorded_at || "") - Date.parse(left.node.recorded_at || "")
  )).slice(0, includeWeakLexical
    ? Math.max(Number(options.maximumCandidates), Number(options.maximumConvergenceCandidates))
    : Number(options.maximumCandidates));
}

export function seedRoutingAudit({
  plannedRoutes = [],
  executedRoutes = [],
  candidates = [],
  convergenceCandidates = [],
  primaryMemoryId = "",
  routeStatus = {},
  subjectRouting = {},
  stateRouting = {},
}) {
  const directIds = new Set(candidates.map((candidate) => candidate.node.id));
  const convergenceOnly = convergenceCandidates.filter(
    (candidate) => !directIds.has(candidate.node.id),
  );
  const auditedConvergence = convergenceOnly.slice(0, 10);
  const all = new Map();
  for (const candidate of [...candidates, ...auditedConvergence]) {
    if (all.has(candidate.node.id)) continue;
    all.set(candidate.node.id, {
      memoryId: candidate.node.id,
      matchedMemoryId: clean(candidate.matchedMemoryId) || candidate.node.id,
      admission: directIds.has(candidate.node.id)
        ? candidate.admission || "independent"
        : "convergence-only",
      fusedScore: Number(candidate.score),
      routes: (candidate.routeMatches || []).map((route) => ({
        route: route.route,
        strength: route.strength,
        independentlyAdmissible: Boolean(route.independentlyAdmissible),
        rawScore: Number.isFinite(route.rawScore) ? Number(route.rawScore) : null,
        normalizedScore: Number(route.normalizedScore),
      })),
      accessibility: candidate.accessibility ? {
        value: Number(candidate.accessibility.value),
        policyVersion: candidate.accessibility.policyVersion,
        configurationVersion: candidate.accessibility.configurationVersion,
        scoreAdjustment: Number(candidate.accessibility.scoreAdjustment),
      } : null,
      affectiveBias: candidate.affectiveBias ? {
        scoreAdjustment: Number(candidate.affectiveBias.scoreAdjustment),
        configurationVersion: candidate.affectiveBias.configurationVersion,
        activationMemoryIds: [...candidate.affectiveBias.activationMemoryIds],
        decisionIds: [...candidate.affectiveBias.decisionIds],
        entityIds: [...candidate.affectiveBias.entityIds],
      } : null,
    });
  }
  return {
    plannedRoutes: [...plannedRoutes],
    executedRoutes: [...executedRoutes],
    routeStatus: { ...routeStatus },
    subjectRouting: subjectRouting && typeof subjectRouting === "object"
      ? { ...subjectRouting }
      : {},
    stateRouting: stateRouting && typeof stateRouting === "object"
      ? { ...stateRouting }
      : {},
    directCandidateCount: candidates.length,
    convergenceCandidateCount: convergenceOnly.length,
    omittedConvergenceCandidateCount: Math.max(0, convergenceOnly.length - auditedConvergence.length),
    primaryMemoryId: clean(primaryMemoryId),
    candidates: [...all.values()],
  };
}
