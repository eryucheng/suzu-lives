function clean(value) {
  return String(value ?? "").trim();
}

const COMMON_REQUIRED = ["memoryId", "sourceIds", "confidence", "rationale"];
const COMMON_PROPERTIES = {
  memoryId: { type: "string", minLength: 1 },
  sourceIds: {
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
  },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  rationale: { type: "string", minLength: 1 },
};

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

export const VALUE_ANALYZERS = Object.freeze({
  targetStance: Object.freeze({
    stateFamily: "value",
    role: "target-stance",
    schemaName: "memory-value-target-stance-v1",
    promptVersion: "value-target-stance-v1",
    promptFile: "value-target-stance-system-prompt.md",
    schema: resultSchema(
      ["targetMatch", "stance", "valueLabel", "scopeLabel"],
      {
        targetMatch: {
          type: "string",
          enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"],
        },
        stance: {
          type: "string",
          enum: ["protects", "rejects", "deprioritizes", "mentions", "no_value", "unknown"],
        },
        valueLabel: { type: "string" },
        scopeLabel: { type: "string" },
      },
    ),
  }),
  holderAttribution: Object.freeze({
    stateFamily: "value",
    role: "holder-attribution",
    schemaName: "memory-value-holder-attribution-v1",
    promptVersion: "value-holder-attribution-v1",
    promptFile: "value-holder-attribution-system-prompt.md",
    schema: resultSchema(
      ["holderMatch", "attribution"],
      {
        holderMatch: { type: "string", enum: ["yes", "no", "unknown"] },
        attribution: {
          type: "string",
          enum: [
            "explicit_self_statement",
            "explicit_reported_statement",
            "third_party_attribution",
            "model_inference",
            "quoted_or_roleplay",
            "unknown",
          ],
        },
      },
    ),
  }),
  evidenceBasis: Object.freeze({
    stateFamily: "value",
    role: "evidence-basis",
    schemaName: "memory-value-evidence-basis-v1",
    promptVersion: "value-evidence-basis-v1",
    promptFile: "value-evidence-basis-system-prompt.md",
    schema: resultSchema(
      ["evidenceType", "alternatives", "agency", "costType", "protectedValueMatch"],
      {
        evidenceType: {
          type: "string",
          enum: [
            "explicit_principle",
            "reasoned_priority",
            "costly_choice",
            "ordinary_choice",
            "constrained_behavior",
            "instrumental_behavior",
            "slogan_or_aspiration",
            "no_tradeoff",
            "unknown",
          ],
        },
        alternatives: { type: "string", enum: ["present", "absent", "unknown"] },
        agency: { type: "string", enum: ["active", "constrained", "unknown"] },
        costType: {
          type: "string",
          enum: ["material", "time", "emotional", "social", "opportunity", "none", "unknown"],
        },
        protectedValueMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      },
    ),
  }),
  timeRevision: Object.freeze({
    stateFamily: "value",
    role: "time-revision",
    schemaName: "memory-value-time-revision-v1",
    promptVersion: "value-time-revision-v1",
    promptFile: "value-time-revision-system-prompt.md",
    schema: resultSchema(
      ["stateTime", "revisionCue"],
      {
        stateTime: { type: "string", enum: ["current", "historical", "temporary", "future", "unknown"] },
        revisionCue: { type: "string", enum: ["changed", "clarified", "none", "unknown"] },
      },
    ),
  }),
  currentRelation: Object.freeze({
    stateFamily: "value",
    role: "current-relation",
    schemaName: "memory-value-current-relation-v1",
    promptVersion: "value-current-relation-v1",
    promptFile: "value-current-relation-system-prompt.md",
    schema: resultSchema(
      ["currentStatePresent", "relation", "scopeOverlap"],
      {
        currentStatePresent: { type: "boolean" },
        relation: {
          type: "string",
          enum: [
            "no_current_state",
            "equivalent",
            "supports",
            "narrows",
            "broadens",
            "same_scope_conflict",
            "replaces",
            "unrelated",
            "unknown",
          ],
        },
        scopeOverlap: { type: "string", enum: ["exact", "partial", "none", "unknown"] },
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
    throw new Error(`Value analysis ${index} must be an object.`);
  }
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set(
    (Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean),
  )];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Value analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "target-stance") {
    return {
      ...common,
      targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, [
        "exact", "subcategory", "broader_category", "contextual", "none", "unknown",
      ]),
      stance: requireEnum(value.stance, `analyses[${index}].stance`, [
        "protects", "rejects", "deprioritizes", "mentions", "no_value", "unknown",
      ]),
      valueLabel: clean(value.valueLabel),
      scopeLabel: clean(value.scopeLabel),
    };
  }
  if (role === "holder-attribution") {
    return {
      ...common,
      holderMatch: requireEnum(value.holderMatch, `analyses[${index}].holderMatch`, ["yes", "no", "unknown"]),
      attribution: requireEnum(value.attribution, `analyses[${index}].attribution`, [
        "explicit_self_statement",
        "explicit_reported_statement",
        "third_party_attribution",
        "model_inference",
        "quoted_or_roleplay",
        "unknown",
      ]),
    };
  }
  if (role === "evidence-basis") {
    return {
      ...common,
      evidenceType: requireEnum(value.evidenceType, `analyses[${index}].evidenceType`, [
        "explicit_principle",
        "reasoned_priority",
        "costly_choice",
        "ordinary_choice",
        "constrained_behavior",
        "instrumental_behavior",
        "slogan_or_aspiration",
        "no_tradeoff",
        "unknown",
      ]),
      alternatives: requireEnum(value.alternatives, `analyses[${index}].alternatives`, ["present", "absent", "unknown"]),
      agency: requireEnum(value.agency, `analyses[${index}].agency`, ["active", "constrained", "unknown"]),
      costType: requireEnum(value.costType, `analyses[${index}].costType`, [
        "material", "time", "emotional", "social", "opportunity", "none", "unknown",
      ]),
      protectedValueMatch: requireEnum(
        value.protectedValueMatch,
        `analyses[${index}].protectedValueMatch`,
        ["yes", "no", "unknown"],
      ),
    };
  }
  if (role === "time-revision") {
    return {
      ...common,
      stateTime: requireEnum(value.stateTime, `analyses[${index}].stateTime`, [
        "current", "historical", "temporary", "future", "unknown",
      ]),
      revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, [
        "changed", "clarified", "none", "unknown",
      ]),
    };
  }
  if (role === "current-relation") {
    if (typeof value.currentStatePresent !== "boolean") {
      throw new Error(`analyses[${index}].currentStatePresent must be boolean.`);
    }
    return {
      ...common,
      currentStatePresent: value.currentStatePresent,
      relation: requireEnum(value.relation, `analyses[${index}].relation`, [
        "no_current_state",
        "equivalent",
        "supports",
        "narrows",
        "broadens",
        "same_scope_conflict",
        "replaces",
        "unrelated",
        "unknown",
      ]),
      scopeOverlap: requireEnum(value.scopeOverlap, `analyses[${index}].scopeOverlap`, [
        "exact", "partial", "none", "unknown",
      ]),
    };
  }
  throw new Error(`Unknown value analyzer role: ${role || "(empty)"}.`);
}

export function parseValueGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(VALUE_ANALYZERS).some((item) => item.role === role)) {
    throw new Error(`Unknown value analyzer role: ${clean(role) || "(empty)"}.`);
  }
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed.replace(/^\uFEFF/u, "").trim());
    } catch (error) {
      throw new Error(`Value analyzer did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Value analyzer output requires an analyses array.");
  }
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) {
    throw new Error(`Value analyzer returned more than ${limit} analyses.`);
  }
  return {
    analyses: parsed.analyses.map((item, index) => parseRoleItem(role, item, index)),
  };
}

export function buildValueGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !definition?.role) {
    throw new Error("Value generation requires a snapshot and known analyzer.");
  }
  return [
    `当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责。主体、canonicalKey、价值标签和候选记忆均由调用方固定。",
    "不得把口号、被迫行为、普通频率、偏好或目标改写成价值；currentState 只读。",
    "只引用快照内对应记忆自己的 sourceIds；没有证据时省略。只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
