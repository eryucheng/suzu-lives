import { simulatePreferenceFormation } from "./preference-simulator.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function validatedAnalysisRequest(repository, evaluation, value) {
  if (!value) return null;
  const requestId = clean(value.id);
  const agentId = clean(evaluation.snapshot.agentId);
  const request = repository.getStateAnalysisRequest(agentId, requestId);
  const target = evaluation.snapshot.target;
  if (!request
    || request.state_family !== "preference"
    || request.representation_layer !== "reported"
    || request.evidence_mode !== "explicit"
    || request.subject_role !== target.subjectRole
    || request.subject_key !== target.subjectKey
    || request.canonical_key !== target.canonicalKey) {
    throw new Error("Preference analysis request does not match the evaluated target.");
  }
  const allowedMemoryIds = new Set(request.memoryIds);
  const allowedSourceIds = new Set(request.sourceIds);
  if (evaluation.snapshot.memories.some((memory) => !allowedMemoryIds.has(memory.id))
    || evaluation.snapshot.sourceRecords.some((source) => !allowedSourceIds.has(source.id))) {
    throw new Error("Preference analysis exceeded its persisted evidence request.");
  }
  return request;
}

function byMemory(items) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item.memoryId, item]));
}

function directionForSignal(signal) {
  if ([
    "explicit_preference", "active_choice", "repeated_behavior",
    "active_sharing", "voluntary_acceptance",
  ].includes(signal)) return "support";
  if (["explicit_rejection", "counter_behavior"].includes(signal)) return "opposition";
  return "neutral";
}

function topicInitiation(interactionType) {
  return {
    spontaneous_share: "self_initiated",
    unprompted_return: "unprompted_return",
    prompted_answer: "prompted",
    task_explanation: "task_required",
  }[interactionType] || "unknown";
}

function affectiveExpression(value) {
  return ["positive", "negative", "neutral", "unknown"].includes(value)
    ? value
    : "unknown";
}

function expressionSignal(explicit) {
  if (!explicit || explicit.directness !== "explicit_self_statement") return "";
  if (["likes", "prefers"].includes(explicit.expressionType)) return "explicit_preference";
  if (explicit.expressionType === "dislikes") return "explicit_rejection";
  return "";
}

function behaviorSignal(behavior, timeScope) {
  if (!behavior) return "";
  if (behavior.behaviorType === "choice") return "active_choice";
  if (behavior.behaviorType === "acceptance") return "voluntary_acceptance";
  if (behavior.behaviorType === "avoidance") return "counter_behavior";
  if (behavior.behaviorType === "exposure") return "passive_exposure";
  if (behavior.behaviorType === "routine") {
    return ["repeated", "habitual"].includes(timeScope?.occurrencePattern)
      ? "repeated_behavior"
      : "single_occurrence";
  }
  return "";
}

function sharingSignal(sharing) {
  if (!sharing) return "";
  if (["spontaneous_share", "unprompted_return"].includes(sharing.interactionType)
    && sharing.affectiveExpression === "positive") return "active_sharing";
  return "";
}

function crossRoleConflict(explicitSignal, behaviorSignalValue, sharing) {
  if (explicitSignal === "explicit_preference" && behaviorSignalValue === "counter_behavior") {
    return "explicit-support-conflicts-with-same-memory-avoidance";
  }
  if (explicitSignal === "explicit_rejection"
    && ["active_choice", "voluntary_acceptance"].includes(behaviorSignalValue)) {
    return "explicit-rejection-conflicts-with-same-memory-approach";
  }
  if (explicitSignal === "explicit_rejection"
    && sharingSignal(sharing) === "active_sharing") {
    return "explicit-rejection-conflicts-with-same-memory-positive-sharing";
  }
  return "";
}

function prerequisiteGate({ object, timeScope, signal, conflict }) {
  if (!object) return { qualification: "unresolved", reason: "missing-object-grounding" };
  if (object.targetMatch === "none") {
    return { qualification: "excluded", reason: "object-does-not-match-target" };
  }
  if (object.targetMatch === "unknown") {
    return { qualification: "unresolved", reason: "object-match-unknown" };
  }
  if (object.targetMatch === "broader_category") {
    return { qualification: "unresolved", reason: "object-scope-is-broader-than-target" };
  }
  if (!timeScope) return { qualification: "unresolved", reason: "missing-time-scope-analysis" };
  if (signal.startsWith("explicit_") && ["historical", "future"].includes(timeScope.stateTime)) {
    return { qualification: "unresolved", reason: `explicit-expression-is-${timeScope.stateTime}` };
  }
  if (signal.startsWith("explicit_") && timeScope.stateTime === "unknown") {
    return { qualification: "unresolved", reason: "explicit-expression-time-unknown" };
  }
  if (conflict) return { qualification: "unresolved", reason: conflict };
  return null;
}

function selectSignal({ explicit, behavior, sharing, timeScope }) {
  const explicitValue = expressionSignal(explicit);
  const behaviorValue = behaviorSignal(behavior, timeScope);
  const sharingValue = sharingSignal(sharing);
  return {
    signal: explicitValue || behaviorValue || sharingValue,
    explicitSignal: explicitValue,
    behaviorSignal: behaviorValue,
    sharingSignal: sharingValue,
  };
}

function mergedConfidence(items) {
  const values = items.filter(Boolean).map((item) => Number(item.confidence)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : 0.5;
}

function buildMergedCandidates(evaluation) {
  const maps = Object.fromEntries(
    Object.entries(evaluation.analyses).map(([key, items]) => [key, byMemory(items)]),
  );
  return evaluation.snapshot.memories.flatMap((memory) => {
    const object = maps.objectGrounding?.get(memory.id) || null;
    const explicit = maps.explicitExpression?.get(memory.id) || null;
    const behavior = maps.behaviorConditions?.get(memory.id) || null;
    const sharing = maps.sharingAffect?.get(memory.id) || null;
    const timeScope = maps.timeScope?.get(memory.id) || null;
    const selected = selectSignal({ explicit, behavior, sharing, timeScope });
    if (!selected.signal) return [];
    const conflict = crossRoleConflict(selected.explicitSignal, selected.behaviorSignal, sharing);
    const preGate = prerequisiteGate({ object, timeScope, signal: selected.signal, conflict });
    const sourceIds = [...new Set(
      [object, explicit, behavior, sharing, timeScope]
        .filter(Boolean)
        .flatMap((item) => item.sourceIds),
    )].sort();
    const runIds = Object.entries(maps)
      .filter(([, map]) => map.has(memory.id))
      .map(([key]) => evaluation.runs[key]?.id)
      .filter(Boolean)
      .sort();
    const label = {
      memoryId: memory.id,
      sourceIds,
      signal: selected.signal,
      confidence: mergedConfidence([object, explicit, behavior, sharing, timeScope]),
      subjectRole: evaluation.snapshot.target.subjectRole,
      subjectKey: evaluation.snapshot.target.subjectKey,
      evidenceGroupId: memory.evidenceGroupId,
      contextId: memory.contextId,
      eventTime: memory.eventStart || memory.eventDate || memory.knownAt,
      knownAt: memory.knownAt,
      agency: behavior?.agency || "unknown",
      constraint: behavior?.constraint || "unknown",
      alternatives: behavior?.alternatives || "unknown",
      instrumentalGoal: behavior?.instrumentalGoal || "unknown",
      opportunityCost: behavior?.opportunityCost || "unknown",
      topicInitiation: topicInitiation(sharing?.interactionType),
      affectiveExpression: affectiveExpression(sharing?.affectiveExpression),
      canDecline: behavior?.canDecline === "yes",
      rationale: [object, explicit, behavior, sharing, timeScope]
        .filter(Boolean)
        .map((item) => item.rationale)
        .filter(Boolean)
        .join("; "),
    };
    return [{
      memory,
      object,
      explicit,
      behavior,
      sharing,
      timeScope,
      selected,
      preGate,
      sourceIds,
      runIds,
      label,
    }];
  });
}

export function mergePreferenceSpecialistEvidence(repository, {
  evaluation,
  policy,
  persistEvidenceLedger = true,
  analysisRequest = null,
} = {}) {
  if (!repository) throw new Error("Preference specialist merge requires a repository.");
  if (!evaluation?.snapshot || !evaluation?.analyses || !evaluation?.runs) {
    throw new Error("Preference specialist merge requires a specialist evaluation result.");
  }
  if (evaluation.status === "incomplete") {
    return {
      status: "blocked",
      reason: "required-specialist-failed-or-rejected",
      labels: [],
      auditCandidates: [],
      preview: null,
      observations: [],
      automaticMemoryWriteAllowed: false,
    };
  }
  const persistedRequest = validatedAnalysisRequest(repository, evaluation, analysisRequest);
  const currentState = repository.getCurrentCanonicalMemory({
    agentId: evaluation.snapshot.agentId,
    subjectRole: evaluation.snapshot.target.subjectRole,
    subjectKey: evaluation.snapshot.target.subjectKey,
    canonicalKey: evaluation.snapshot.target.canonicalKey,
    stateFamily: "preference",
  });
  const candidates = buildMergedCandidates(evaluation).map((candidate) => {
    if (candidate.preGate || !currentState
      || directionForSignal(candidate.label.signal) !== "opposition") return candidate;
    return {
      ...candidate,
      preGate: {
        qualification: "unresolved",
        reason: "counter-match-required",
      },
    };
  }).map((candidate) => {
    if (candidate.preGate || policy
      || ["explicit_preference", "explicit_rejection"].includes(candidate.label.signal)) {
      return candidate;
    }
    return {
      ...candidate,
      preGate: {
        qualification: "unresolved",
        reason: "preference-formation-policy-required",
      },
    };
  });
  const eligibleLabels = candidates.filter((item) => !item.preGate).map((item) => item.label);
  const preview = policy ? simulatePreferenceFormation({
    subjectRole: evaluation.snapshot.target.subjectRole,
    subjectKey: evaluation.snapshot.target.subjectKey,
    canonicalKey: evaluation.snapshot.target.canonicalKey,
    evidence: eligibleLabels,
    policy,
  }) : null;
  const evaluatedByMemory = new Map(
    (Array.isArray(preview?.evidence) ? preview.evidence : []).map((item) => [item.memoryId, item]),
  );
  const observations = persistEvidenceLedger ? repository.transaction(() => (
    candidates.map((candidate) => {
      const evaluated = evaluatedByMemory.get(candidate.memory.id) || null;
      const gate = candidate.preGate || (clean(evaluated?.ignoredReason) ? {
        qualification: "excluded",
        reason: clean(evaluated.ignoredReason),
      } : null);
      const qualification = gate?.qualification || "qualified";
      const claimedDirection = directionForSignal(candidate.label.signal);
      return repository.recordStateEvidenceObservation({
        agentId: evaluation.snapshot.agentId,
        batchId: evaluation.batchId,
        stateFamily: "preference",
        subjectRole: evaluation.snapshot.target.subjectRole,
        subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey,
        memoryId: candidate.memory.id,
        evidenceGroupId: candidate.memory.evidenceGroupId,
        contextId: candidate.memory.contextId,
        signal: candidate.label.signal,
        claimedDirection,
        effectiveDirection: qualification === "qualified" ? claimedDirection : "neutral",
        qualification,
        confidence: candidate.label.confidence,
        origin: "llm",
        scope: {
          kind: candidate.object?.targetMatch || "unknown",
          label: candidate.timeScope?.scopeLabel || candidate.object?.matchedLabel || "",
          context: candidate.timeScope?.contextLabel || "",
          ...(persistedRequest ? {
            currentRepresentationLayer: persistedRequest.representation_layer,
          } : {}),
        },
        payloadSchemaVersion: persistedRequest
          ? "preference-specialist-request-merged-v1"
          : "preference-specialist-merged-v2",
        payload: {
          objectGrounding: candidate.object,
          explicitExpression: candidate.explicit,
          behaviorConditions: candidate.behavior,
          sharingAffect: candidate.sharing,
          timeScope: candidate.timeScope,
          selectedSignals: candidate.selected,
          legacySimulation: evaluated,
          analysisRequest: persistedRequest ? {
            id: persistedRequest.id,
            evidenceMode: persistedRequest.evidence_mode,
            representationLayer: persistedRequest.representation_layer,
          } : null,
        },
        excludedReason: gate?.reason || "",
        sourceIds: candidate.sourceIds,
        analysisRunIds: candidate.runIds,
        observedAt: candidate.label.eventTime,
      });
    })
  )) : [];
  return {
    status: candidates.length ? "merged" : "abstained",
    reason: "",
    labels: eligibleLabels,
    auditCandidates: candidates.map((candidate) => ({
      memoryId: candidate.memory.id,
      signal: candidate.label.signal,
      prerequisiteGate: candidate.preGate,
    })),
    preview,
    observations,
    automaticMemoryWriteAllowed: false,
  };
}
