function clean(value) {
  return String(value ?? "").trim();
}

function normalizedLabel(value) {
  return clean(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function unit(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${label} 必须是 0 到 1 之间的数字。`);
  }
  return number;
}

function stringList(value, label, allowedValues = null) {
  const values = [...new Set((Array.isArray(value) ? value : [])
    .map(clean)
    .filter(Boolean))];
  if (!values.length) throw new Error(`${label} 必须明确列出至少一个值。`);
  if (allowedValues && values.some((item) => !allowedValues.includes(item))) {
    throw new Error(`${label} 包含不支持的值。`);
  }
  return Object.freeze(values);
}

const INTENSITY_FACTOR = Object.freeze({
  low: 1 / 3,
  medium: 2 / 3,
  high: 1,
});

function affectiveClaim(memory) {
  return memory?.metadata?.reportedStateDraft?.affectiveClaim
    || memory?.metadata?.affectiveClaim
    || null;
}

function emotionMatches(stored, current, matchMode) {
  if (clean(stored?.valence) !== current.valence) return false;
  if (matchMode === "valence") return true;
  return normalizedLabel(stored?.label) === normalizedLabel(current.label);
}

function resolveTriggerEntity(entities, trigger) {
  const key = clean(trigger?.key);
  const label = normalizedLabel(trigger?.label);
  if (!key || !label) return null;
  const byId = entities.filter((entity) => clean(entity.id) === key);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return null;
  const byLabel = entities.filter((entity) => (
    [entity.canonical_name, ...(entity.aliases || [])]
      .some((value) => normalizedLabel(value) === label)
  ));
  return byLabel.length === 1 ? byLabel[0] : null;
}

export function normalizeAffectiveBiasOptions(value) {
  if (!value || value.enabled !== true) {
    return Object.freeze({ enabled: false, configurationVersion: "" });
  }
  const configurationVersion = clean(value.configurationVersion);
  const subjectRole = clean(value.subjectRole);
  const subjectKey = clean(value.subjectKey);
  const matchMode = clean(value.matchMode);
  const emotion = value.currentEmotion && typeof value.currentEmotion === "object"
    ? value.currentEmotion
    : null;
  if (!configurationVersion) throw new Error("情绪召回偏置需要明确的 configurationVersion。");
  if (!subjectRole || !subjectKey) throw new Error("情绪召回偏置需要明确的 subjectRole 与 subjectKey。");
  if (!["user", "agent", "other"].includes(subjectRole)) {
    throw new Error("情绪召回偏置 subjectRole 必须是 user、agent 或 other。");
  }
  if (!["exact-label", "valence"].includes(matchMode)) {
    throw new Error("情绪召回偏置 matchMode 必须是 exact-label 或 valence。");
  }
  if (!emotion || !clean(emotion.label)) {
    throw new Error("情绪召回偏置需要明确的 currentEmotion.label。");
  }
  const valence = clean(emotion.valence);
  const intensity = clean(emotion.intensity);
  if (!["positive", "negative", "mixed", "neutral"].includes(valence)) {
    throw new Error("currentEmotion.valence 不受支持。");
  }
  if (!Object.hasOwn(INTENSITY_FACTOR, intensity)) {
    throw new Error("currentEmotion.intensity 必须是 low、medium 或 high。");
  }
  return Object.freeze({
    enabled: true,
    configurationVersion,
    subjectRole,
    subjectKey,
    currentEmotion: Object.freeze({
      label: clean(emotion.label),
      valence,
      intensity,
    }),
    matchMode,
    maximumScoreAdjustment: unit(
      value.maximumScoreAdjustment,
      "affectiveBias.maximumScoreAdjustment",
    ),
    allowedPolicyVersions: stringList(
      value.allowedPolicyVersions,
      "affectiveBias.allowedPolicyVersions",
    ),
    allowedRepresentationLayers: stringList(
      value.allowedRepresentationLayers,
      "affectiveBias.allowedRepresentationLayers",
      ["reported", "established"],
    ),
  });
}

export function buildAffectiveCandidateAdjustments({
  repository,
  agentId,
  policy,
} = {}) {
  const adjustments = new Map();
  if (!policy?.enabled) {
    return Object.freeze({
      adjustments,
      approvedActivationIds: Object.freeze([]),
      matchedActivationIds: Object.freeze([]),
      matchedEntityIds: Object.freeze([]),
    });
  }
  const activations = repository.listEnabledAffectiveActivations(agentId, {
    policyVersions: policy.allowedPolicyVersions,
    representationLayers: policy.allowedRepresentationLayers,
    subjectRole: policy.subjectRole,
    subjectKey: policy.subjectKey,
  });
  const entities = repository.listEntities(agentId);
  const matchedActivationIds = [];
  const matchedEntityIds = new Set();
  for (const activation of activations) {
    const claim = affectiveClaim(activation.memory);
    if (!emotionMatches(claim?.emotion, policy.currentEmotion, policy.matchMode)) continue;
    const entity = resolveTriggerEntity(entities, claim?.trigger);
    if (!entity) continue;
    const storedIntensity = clean(claim?.emotion?.intensity);
    if (!Object.hasOwn(INTENSITY_FACTOR, storedIntensity)) continue;
    const scoreAdjustment = policy.maximumScoreAdjustment
      * INTENSITY_FACTOR[policy.currentEmotion.intensity]
      * INTENSITY_FACTOR[storedIntensity];
    const activationMemoryId = clean(activation.memory?.id);
    const decisionId = clean(activation.decision?.id);
    matchedActivationIds.push(activationMemoryId);
    matchedEntityIds.add(entity.id);
    for (const memory of repository.listEntityMemories({
      agentId,
      entityId: entity.id,
      statuses: ["active"],
    })) {
      const previous = adjustments.get(memory.id);
      const nextScore = Math.max(Number(previous?.scoreAdjustment || 0), scoreAdjustment);
      adjustments.set(memory.id, Object.freeze({
        scoreAdjustment: nextScore,
        configurationVersion: policy.configurationVersion,
        activationMemoryIds: Object.freeze([...new Set([
          ...(previous?.activationMemoryIds || []),
          activationMemoryId,
        ].filter(Boolean))]),
        decisionIds: Object.freeze([...new Set([
          ...(previous?.decisionIds || []),
          decisionId,
        ].filter(Boolean))]),
        entityIds: Object.freeze([...new Set([
          ...(previous?.entityIds || []),
          entity.id,
        ].filter(Boolean))]),
      }));
    }
  }
  return Object.freeze({
    adjustments,
    approvedActivationIds: Object.freeze(activations.map((item) => item.memory.id)),
    matchedActivationIds: Object.freeze([...new Set(matchedActivationIds)]),
    matchedEntityIds: Object.freeze([...matchedEntityIds]),
  });
}

export function affectiveBiasAudit(policy, loaded = {}) {
  if (!policy?.enabled) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    configurationVersion: policy.configurationVersion,
    subjectRole: policy.subjectRole,
    subjectKey: policy.subjectKey,
    matchMode: policy.matchMode,
    currentEmotionProvided: true,
    maximumScoreAdjustment: policy.maximumScoreAdjustment,
    allowedPolicyVersions: Object.freeze([...policy.allowedPolicyVersions]),
    allowedRepresentationLayers: Object.freeze([...policy.allowedRepresentationLayers]),
    approvedActivationIds: Object.freeze([...(loaded.approvedActivationIds || [])]),
    matchedActivationIds: Object.freeze([...(loaded.matchedActivationIds || [])]),
    matchedEntityIds: Object.freeze([...(loaded.matchedEntityIds || [])]),
    adjustedCandidateCount: Number(loaded.adjustedCandidateCount || 0),
  });
}
