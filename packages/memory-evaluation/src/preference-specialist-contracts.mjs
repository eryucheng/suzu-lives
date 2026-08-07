import { PREFERENCE_EVIDENCE_ENUMS } from "./preference-contract.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

const COMMON_REQUIRED = Object.freeze([
  "memoryId",
  "sourceIds",
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

export const PREFERENCE_SPECIALIST_ANALYZERS = Object.freeze({
  objectGrounding: Object.freeze({
    role: "object-grounding",
    schemaName: "memory-preference-object-grounding-v1",
    promptVersion: "preference-object-grounding-v1",
    promptFile: "preference-object-grounding-system-prompt.md",
    schema: resultSchema(["targetMatch", "matchedLabel"], {
      targetMatch: {
        type: "string",
        enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"],
      },
      matchedLabel: { type: "string" },
    }),
  }),
  explicitExpression: Object.freeze({
    role: "explicit-expression",
    schemaName: "memory-preference-explicit-expression-v1",
    promptVersion: "preference-explicit-expression-v1",
    promptFile: "preference-explicit-expression-system-prompt.md",
    schema: resultSchema(["expressionType", "directness"], {
      expressionType: {
        type: "string",
        enum: ["likes", "dislikes", "prefers", "wants", "avoids", "neutral_statement", "none", "unknown"],
      },
      directness: {
        type: "string",
        enum: ["explicit_self_statement", "explicit_reported_statement", "quoted_or_roleplay", "implicit", "unknown"],
      },
    }),
  }),
  behaviorConditions: Object.freeze({
    role: "behavior-conditions",
    schemaName: "memory-preference-behavior-conditions-v1",
    promptVersion: "preference-behavior-conditions-v1",
    promptFile: "preference-behavior-conditions-system-prompt.md",
    schema: resultSchema([
      "behaviorType",
      "agency",
      "constraint",
      "alternatives",
      "instrumentalGoal",
      "opportunityCost",
      "canDecline",
    ], {
      behaviorType: {
        type: "string",
        enum: ["choice", "acceptance", "avoidance", "exposure", "routine", "none", "unknown"],
      },
      agency: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.agency },
      constraint: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.constraint },
      alternatives: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.alternatives },
      instrumentalGoal: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.instrumentalGoal },
      opportunityCost: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.opportunityCost },
      canDecline: { type: "string", enum: ["yes", "no", "unknown"] },
    }),
  }),
  sharingAffect: Object.freeze({
    role: "sharing-affect",
    schemaName: "memory-preference-sharing-affect-v1",
    promptVersion: "preference-sharing-affect-v1",
    promptFile: "preference-sharing-affect-system-prompt.md",
    schema: resultSchema(["interactionType", "affectiveExpression"], {
      interactionType: {
        type: "string",
        enum: [
          "spontaneous_share", "unprompted_return", "prompted_answer",
          "task_explanation", "polite_agreement", "none", "unknown",
        ],
      },
      affectiveExpression: {
        type: "string",
        enum: ["positive", "negative", "neutral", "mixed", "unknown"],
      },
    }),
  }),
  timeScope: Object.freeze({
    role: "time-scope",
    schemaName: "memory-preference-time-scope-v2",
    promptVersion: "preference-time-scope-v2",
    promptFile: "preference-time-scope-system-prompt.md",
    schema: resultSchema(
      [
        "stateTime",
        "occurrencePattern",
        "scopeKind",
        "scopeLabel",
        "contextLabel",
        "revisionCue",
      ],
      {
        stateTime: { type: "string", enum: ["current", "historical", "future", "timeless", "unknown"] },
        occurrencePattern: { type: "string", enum: ["single", "repeated", "habitual", "unknown"] },
        scopeKind: { type: "string", enum: ["exact_object", "subcategory", "category", "context_only", "unknown"] },
        scopeLabel: { type: "string" },
        contextLabel: { type: "string" },
        revisionCue: {
          type: "string",
          enum: ["none", "changed", "clarified", "denies_prior_state", "unknown"],
        },
      },
    ),
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
    throw new Error(`Preference specialist analysis ${index} must be an object.`);
  }
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set(
    (Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean),
  )];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Preference specialist analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "object-grounding") {
    return {
      ...common,
      targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, [
        "exact", "subcategory", "broader_category", "contextual", "none", "unknown",
      ]),
      matchedLabel: clean(value.matchedLabel),
    };
  }
  if (role === "explicit-expression") {
    return {
      ...common,
      expressionType: requireEnum(value.expressionType, `analyses[${index}].expressionType`, [
        "likes", "dislikes", "prefers", "wants", "avoids", "neutral_statement", "none", "unknown",
      ]),
      directness: requireEnum(value.directness, `analyses[${index}].directness`, [
        "explicit_self_statement", "explicit_reported_statement", "quoted_or_roleplay", "implicit", "unknown",
      ]),
    };
  }
  if (role === "behavior-conditions") {
    return {
      ...common,
      behaviorType: requireEnum(value.behaviorType, `analyses[${index}].behaviorType`, [
        "choice", "acceptance", "avoidance", "exposure", "routine", "none", "unknown",
      ]),
      agency: requireEnum(value.agency, `analyses[${index}].agency`, PREFERENCE_EVIDENCE_ENUMS.agency),
      constraint: requireEnum(value.constraint, `analyses[${index}].constraint`, PREFERENCE_EVIDENCE_ENUMS.constraint),
      alternatives: requireEnum(value.alternatives, `analyses[${index}].alternatives`, PREFERENCE_EVIDENCE_ENUMS.alternatives),
      instrumentalGoal: requireEnum(
        value.instrumentalGoal,
        `analyses[${index}].instrumentalGoal`,
        PREFERENCE_EVIDENCE_ENUMS.instrumentalGoal,
      ),
      opportunityCost: requireEnum(
        value.opportunityCost,
        `analyses[${index}].opportunityCost`,
        PREFERENCE_EVIDENCE_ENUMS.opportunityCost,
      ),
      canDecline: requireEnum(value.canDecline, `analyses[${index}].canDecline`, ["yes", "no", "unknown"]),
    };
  }
  if (role === "sharing-affect") {
    return {
      ...common,
      interactionType: requireEnum(value.interactionType, `analyses[${index}].interactionType`, [
        "spontaneous_share", "unprompted_return", "prompted_answer",
        "task_explanation", "polite_agreement", "none", "unknown",
      ]),
      affectiveExpression: requireEnum(value.affectiveExpression, `analyses[${index}].affectiveExpression`, [
        "positive", "negative", "neutral", "mixed", "unknown",
      ]),
    };
  }
  if (role === "time-scope") {
    return {
      ...common,
      stateTime: requireEnum(value.stateTime, `analyses[${index}].stateTime`, [
        "current", "historical", "future", "timeless", "unknown",
      ]),
      occurrencePattern: requireEnum(value.occurrencePattern, `analyses[${index}].occurrencePattern`, [
        "single", "repeated", "habitual", "unknown",
      ]),
      scopeKind: requireEnum(value.scopeKind, `analyses[${index}].scopeKind`, [
        "exact_object", "subcategory", "category", "context_only", "unknown",
      ]),
      scopeLabel: clean(value.scopeLabel),
      contextLabel: clean(value.contextLabel),
      revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, [
        "none", "changed", "clarified", "denies_prior_state", "unknown",
      ]),
    };
  }
  throw new Error(`Unknown preference specialist role: ${role || "(empty)"}.`);
}

export function parsePreferenceSpecialistGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Preference specialist returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Preference specialist did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Preference specialist output requires an analyses array.");
  }
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) {
    throw new Error(`Preference specialist returned more than ${limit} analyses.`);
  }
  return { analyses: parsed.analyses.map((item, index) => parseRoleItem(role, item, index)) };
}

export function buildPreferenceSpecialistGenerationInput(snapshot, analyzerRole) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Preference specialist generation requires a snapshot object.");
  }
  return [
    `当前专职角色：${clean(analyzerRole)}。`,
    "只处理系统提示词规定的单一职责。不得输出最终偏好等级。",
    "只引用快照内对应记忆自己的 sourceIds。没有证据时省略该记忆，不用猜测补齐。",
    "只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
