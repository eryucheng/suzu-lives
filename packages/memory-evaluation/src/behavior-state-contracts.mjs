function clean(value) {
  return String(value ?? "").trim();
}

const TARGET_MATCHES = Object.freeze([
  "exact",
  "subcategory",
  "broader_category",
  "contextual",
  "none",
  "unknown",
]);

const COMMON_REQUIRED = Object.freeze([
  "memoryId",
  "sourceIds",
  "targetMatch",
  "matchedLabel",
  "confidence",
  "rationale",
]);

const COMMON_PROPERTIES = Object.freeze({
  memoryId: { type: "string", minLength: 1 },
  sourceIds: {
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
  },
  targetMatch: { type: "string", enum: TARGET_MATCHES },
  matchedLabel: { type: "string" },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  rationale: { type: "string", minLength: 1 },
});

function resultSchema(required, properties) {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["analyses"],
    properties: {
      analyses: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          additionalProperties: false,
          required: [...COMMON_REQUIRED, ...required],
          properties: { ...COMMON_PROPERTIES, ...properties },
        },
      },
    },
  });
}

export const BEHAVIOR_STATE_ANALYZERS = Object.freeze({
  condition: Object.freeze({
    stateFamily: "condition",
    role: "condition-evidence",
    schemaName: "memory-condition-evidence-v2",
    promptVersion: "condition-evidence-v2",
    promptFile: "condition-evidence-system-prompt.md",
    schema: resultSchema([
      "conditionPresence",
      "conditionKind",
      "effect",
      "temporality",
      "evidenceBasis",
      "scopeLabel",
      "revisionCue",
    ], {
      conditionPresence: { type: "string", enum: ["present", "absent", "unknown"] },
      conditionKind: {
        type: "string",
        enum: [
          "work", "health", "resource", "time", "institutional", "social",
          "environmental", "emotional", "other", "unknown",
        ],
      },
      effect: { type: "string", enum: ["constrains", "enables", "explains", "none", "unknown"] },
      temporality: { type: "string", enum: ["current", "historical", "temporary", "future", "unknown"] },
      evidenceBasis: {
        type: "string",
        enum: ["explicit_self_report", "direct_observation", "reported_by_other", "inferred", "unknown"],
      },
      scopeLabel: { type: "string" },
      revisionCue: {
        type: "string",
        enum: ["none", "started", "ended", "changed", "clarified", "denies_prior_state", "unknown"],
      },
    }),
  }),
  habit: Object.freeze({
    stateFamily: "habit",
    role: "habit-evidence",
    schemaName: "memory-habit-evidence-v2",
    promptVersion: "habit-evidence-v2",
    promptFile: "habit-evidence-system-prompt.md",
    schema: resultSchema([
      "patternType",
      "regularity",
      "timeState",
      "evidenceBasis",
      "constraint",
      "contextLabel",
      "revisionCue",
    ], {
      patternType: {
        type: "string",
        enum: ["single", "repeated", "habitual", "interrupted", "stopped", "none", "unknown"],
      },
      regularity: {
        type: "string",
        enum: ["daily", "weekly", "occasional", "context_triggered", "irregular", "unknown"],
      },
      timeState: { type: "string", enum: ["current", "historical", "changed", "unknown"] },
      evidenceBasis: {
        type: "string",
        enum: ["explicit_self_report", "direct_observation", "reported_by_other", "inferred", "unknown"],
      },
      constraint: {
        type: "string",
        enum: ["none", "work", "health", "resource", "institutional", "social", "other", "unknown"],
      },
      contextLabel: { type: "string" },
      revisionCue: {
        type: "string",
        enum: ["none", "changed", "clarified", "interrupted", "stopped", "denies_prior_state", "unknown"],
      },
    }),
  }),
  disposition: Object.freeze({
    stateFamily: "disposition",
    role: "disposition-evidence",
    schemaName: "memory-disposition-evidence-v2",
    promptVersion: "disposition-evidence-v2",
    promptFile: "disposition-evidence-system-prompt.md",
    schema: resultSchema([
      "tendencyPresence",
      "evidenceType",
      "crossContext",
      "externalConstraint",
      "timeState",
      "situationLabel",
      "responseLabel",
      "revisionCue",
    ], {
      tendencyPresence: { type: "string", enum: ["present", "absent", "unknown"] },
      evidenceType: {
        type: "string",
        enum: [
          "explicit_self_description", "repeated_cross_context", "repeated_single_context",
          "single_response", "third_party_description", "inferred", "unknown",
        ],
      },
      crossContext: { type: "string", enum: ["yes", "no", "unknown"] },
      externalConstraint: { type: "string", enum: ["present", "absent", "unknown"] },
      timeState: { type: "string", enum: ["current", "historical", "changed", "unknown"] },
      situationLabel: { type: "string" },
      responseLabel: { type: "string" },
      revisionCue: {
        type: "string",
        enum: ["none", "changed", "clarified", "denies_prior_state", "unknown"],
      },
    }),
  }),
});

function requireEnum(value, field, allowed) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) {
    throw new Error(`${field} has an unknown value: ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function parseCommon(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Behavior state analysis ${index} must be an object.`);
  }
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set(
    (Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean),
  )];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Behavior state analysis ${index} has an invalid common envelope.`);
  }
  return {
    memoryId,
    sourceIds,
    targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, TARGET_MATCHES),
    matchedLabel: clean(value.matchedLabel),
    confidence,
    rationale,
  };
}

function parseFamilyItem(stateFamily, value, index) {
  const common = parseCommon(value, index);
  if (stateFamily === "condition") {
    return {
      ...common,
      conditionPresence: requireEnum(value.conditionPresence, `analyses[${index}].conditionPresence`, ["present", "absent", "unknown"]),
      conditionKind: requireEnum(value.conditionKind, `analyses[${index}].conditionKind`, [
        "work", "health", "resource", "time", "institutional", "social",
        "environmental", "emotional", "other", "unknown",
      ]),
      effect: requireEnum(value.effect, `analyses[${index}].effect`, ["constrains", "enables", "explains", "none", "unknown"]),
      temporality: requireEnum(value.temporality, `analyses[${index}].temporality`, ["current", "historical", "temporary", "future", "unknown"]),
      evidenceBasis: requireEnum(value.evidenceBasis, `analyses[${index}].evidenceBasis`, [
        "explicit_self_report", "direct_observation", "reported_by_other", "inferred", "unknown",
      ]),
      scopeLabel: clean(value.scopeLabel),
      revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, [
        "none", "started", "ended", "changed", "clarified", "denies_prior_state", "unknown",
      ]),
    };
  }
  if (stateFamily === "habit") {
    return {
      ...common,
      patternType: requireEnum(value.patternType, `analyses[${index}].patternType`, [
        "single", "repeated", "habitual", "interrupted", "stopped", "none", "unknown",
      ]),
      regularity: requireEnum(value.regularity, `analyses[${index}].regularity`, [
        "daily", "weekly", "occasional", "context_triggered", "irregular", "unknown",
      ]),
      timeState: requireEnum(value.timeState, `analyses[${index}].timeState`, ["current", "historical", "changed", "unknown"]),
      evidenceBasis: requireEnum(value.evidenceBasis, `analyses[${index}].evidenceBasis`, [
        "explicit_self_report", "direct_observation", "reported_by_other", "inferred", "unknown",
      ]),
      constraint: requireEnum(value.constraint, `analyses[${index}].constraint`, [
        "none", "work", "health", "resource", "institutional", "social", "other", "unknown",
      ]),
      contextLabel: clean(value.contextLabel),
      revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, [
        "none", "changed", "clarified", "interrupted", "stopped", "denies_prior_state", "unknown",
      ]),
    };
  }
  if (stateFamily === "disposition") {
    return {
      ...common,
      tendencyPresence: requireEnum(value.tendencyPresence, `analyses[${index}].tendencyPresence`, ["present", "absent", "unknown"]),
      evidenceType: requireEnum(value.evidenceType, `analyses[${index}].evidenceType`, [
        "explicit_self_description", "repeated_cross_context", "repeated_single_context",
        "single_response", "third_party_description", "inferred", "unknown",
      ]),
      crossContext: requireEnum(value.crossContext, `analyses[${index}].crossContext`, ["yes", "no", "unknown"]),
      externalConstraint: requireEnum(value.externalConstraint, `analyses[${index}].externalConstraint`, ["present", "absent", "unknown"]),
      timeState: requireEnum(value.timeState, `analyses[${index}].timeState`, ["current", "historical", "changed", "unknown"]),
      situationLabel: clean(value.situationLabel),
      responseLabel: clean(value.responseLabel),
      revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, [
        "none", "changed", "clarified", "denies_prior_state", "unknown",
      ]),
    };
  }
  throw new Error(`Unknown behavior state family: ${stateFamily || "(empty)"}.`);
}

export function parseBehaviorStateGeneration(stateFamily, value, { maximumAnalyses = 60 } = {}) {
  if (!BEHAVIOR_STATE_ANALYZERS[stateFamily]) {
    throw new Error(`Unknown behavior state family: ${clean(stateFamily) || "(empty)"}.`);
  }
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Behavior state analyzer returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Behavior state analyzer did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Behavior state analyzer output requires an analyses array.");
  }
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) {
    throw new Error(`Behavior state analyzer returned more than ${limit} analyses.`);
  }
  return { analyses: parsed.analyses.map((item, index) => parseFamilyItem(stateFamily, item, index)) };
}

export function buildBehaviorStateGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Behavior state generation requires a snapshot object.");
  }
  if (!definition?.stateFamily || !definition?.role) {
    throw new Error("Behavior state generation requires a known analyzer definition.");
  }
  return [
    `当前状态家族：${definition.stateFamily}。当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责，不要推断其他状态家族，也不要输出最终人物结论。",
    "目标主体、canonicalKey 和候选记忆均由调用方固定；不得修改主体、发明新目标或扫描快照之外的信息。",
    "只引用快照内对应记忆自己的 sourceIds。没有证据时省略该记忆，不要猜测补齐。",
    "只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
