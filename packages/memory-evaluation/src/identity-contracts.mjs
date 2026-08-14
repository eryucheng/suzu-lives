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

function schema(required, properties) {
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

export const IDENTITY_ANALYZERS = Object.freeze({
  fieldValue: Object.freeze({
    stateFamily: "identity",
    role: "field-value",
    schemaName: "memory-identity-field-value-v1",
    promptVersion: "identity-field-value-v1",
    promptFile: "identity-field-value-system-prompt.md",
    schema: schema(["targetMatch", "identityField", "valueText", "statementPolarity", "valueScope"], {
      targetMatch: { type: "string", enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"] },
      identityField: { type: "string", enum: ["name", "alias", "birth_date", "birth_year", "age", "gender", "pronouns", "occupation", "employer", "education", "residence", "hometown", "nationality", "biography", "other", "unknown"] },
      valueText: { type: "string" },
      statementPolarity: { type: "string", enum: ["asserts", "denies", "no_fact", "unknown"] },
      valueScope: { type: "string" },
    }),
  }),
  subjectAttribution: Object.freeze({
    stateFamily: "identity",
    role: "subject-attribution",
    schemaName: "memory-identity-subject-attribution-v1",
    promptVersion: "identity-subject-attribution-v1",
    promptFile: "identity-subject-attribution-system-prompt.md",
    schema: schema(["subjectMatch", "attribution"], {
      subjectMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      attribution: { type: "string", enum: ["explicit_self_report", "official_record", "direct_system_record", "third_party_report", "model_inference", "quoted_or_roleplay", "unknown"] },
    }),
  }),
  familyBoundary: Object.freeze({
    stateFamily: "identity",
    role: "family-boundary",
    schemaName: "memory-identity-family-boundary-v1",
    promptVersion: "identity-family-boundary-v1",
    promptFile: "identity-family-boundary-system-prompt.md",
    schema: schema(["classification", "sensitivity"], {
      classification: { type: "string", enum: ["identity_fact", "transient_condition", "relationship_role", "self_concept", "preference", "capability", "value", "credential_or_secret", "no_identity_fact", "unknown"] },
      sensitivity: { type: "string", enum: ["ordinary", "personal", "sensitive", "restricted", "credential", "unknown"] },
    }),
  }),
  timeRevision: Object.freeze({
    stateFamily: "identity",
    role: "time-revision",
    schemaName: "memory-identity-time-revision-v1",
    promptVersion: "identity-time-revision-v1",
    promptFile: "identity-time-revision-system-prompt.md",
    schema: schema(["factTime", "revisionCue", "timeReference"], {
      factTime: { type: "string", enum: ["current", "historical", "timeless", "future", "temporary", "unknown"] },
      revisionCue: { type: "string", enum: ["started", "changed", "ended", "clarified", "denies_prior_state", "none", "unknown"] },
      timeReference: { type: "string" },
    }),
  }),
  currentRelation: Object.freeze({
    stateFamily: "identity",
    role: "current-relation",
    schemaName: "memory-identity-current-relation-v1",
    promptVersion: "identity-current-relation-v1",
    promptFile: "identity-current-relation-system-prompt.md",
    schema: schema(["currentStatePresent", "relation", "valueOverlap"], {
      currentStatePresent: { type: "boolean" },
      relation: { type: "string", enum: ["no_current_state", "equivalent", "supports", "additional_value", "value_changed", "narrows", "broadens", "retires", "same_scope_conflict", "unrelated", "unknown"] },
      valueOverlap: { type: "string", enum: ["exact", "partial", "none", "unknown"] },
    }),
  }),
});

function enumValue(value, field, allowed) {
  const text = clean(value);
  if (!allowed.includes(text)) {
    throw new Error(`${field} has an unknown value: ${text || "(empty)"}.`);
  }
  return text;
}

function common(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Identity analysis ${index} must be an object.`);
  }
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set(
    (Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean),
  )];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Identity analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseItem(role, value, index) {
  const base = common(value, index);
  if (role === "field-value") {
    return {
      ...base,
      targetMatch: enumValue(value.targetMatch, `analyses[${index}].targetMatch`, ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"]),
      identityField: enumValue(value.identityField, `analyses[${index}].identityField`, ["name", "alias", "birth_date", "birth_year", "age", "gender", "pronouns", "occupation", "employer", "education", "residence", "hometown", "nationality", "biography", "other", "unknown"]),
      valueText: clean(value.valueText),
      statementPolarity: enumValue(value.statementPolarity, `analyses[${index}].statementPolarity`, ["asserts", "denies", "no_fact", "unknown"]),
      valueScope: clean(value.valueScope),
    };
  }
  if (role === "subject-attribution") {
    return {
      ...base,
      subjectMatch: enumValue(value.subjectMatch, `analyses[${index}].subjectMatch`, ["yes", "no", "unknown"]),
      attribution: enumValue(value.attribution, `analyses[${index}].attribution`, ["explicit_self_report", "official_record", "direct_system_record", "third_party_report", "model_inference", "quoted_or_roleplay", "unknown"]),
    };
  }
  if (role === "family-boundary") {
    return {
      ...base,
      classification: enumValue(value.classification, `analyses[${index}].classification`, ["identity_fact", "transient_condition", "relationship_role", "self_concept", "preference", "capability", "value", "credential_or_secret", "no_identity_fact", "unknown"]),
      sensitivity: enumValue(value.sensitivity, `analyses[${index}].sensitivity`, ["ordinary", "personal", "sensitive", "restricted", "credential", "unknown"]),
    };
  }
  if (role === "time-revision") {
    return {
      ...base,
      factTime: enumValue(value.factTime, `analyses[${index}].factTime`, ["current", "historical", "timeless", "future", "temporary", "unknown"]),
      revisionCue: enumValue(value.revisionCue, `analyses[${index}].revisionCue`, ["started", "changed", "ended", "clarified", "denies_prior_state", "none", "unknown"]),
      timeReference: clean(value.timeReference),
    };
  }
  if (role === "current-relation") {
    if (typeof value.currentStatePresent !== "boolean") {
      throw new Error(`analyses[${index}].currentStatePresent must be boolean.`);
    }
    return {
      ...base,
      currentStatePresent: value.currentStatePresent,
      relation: enumValue(value.relation, `analyses[${index}].relation`, ["no_current_state", "equivalent", "supports", "additional_value", "value_changed", "narrows", "broadens", "retires", "same_scope_conflict", "unrelated", "unknown"]),
      valueOverlap: enumValue(value.valueOverlap, `analyses[${index}].valueOverlap`, ["exact", "partial", "none", "unknown"]),
    };
  }
  throw new Error(`Unknown identity analyzer role: ${role || "(empty)"}.`);
}

export function parseIdentityGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(IDENTITY_ANALYZERS).some((definition) => definition.role === role)) {
    throw new Error(`Unknown identity analyzer role: ${clean(role) || "(empty)"}.`);
  }
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed.replace(/^\uFEFF/u, "").trim());
    } catch (error) {
      throw new Error(`Identity analyzer did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Identity analyzer output requires an analyses array.");
  }
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) {
    throw new Error(`Identity analyzer returned more than ${limit} analyses.`);
  }
  return { analyses: parsed.analyses.map((item, index) => parseItem(role, item, index)) };
}

export function buildIdentityGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !definition?.role) {
    throw new Error("Identity generation requires a snapshot and known analyzer.");
  }
  return [
    `当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责。主体、identityField、fieldCardinality、canonicalKey 和候选记忆均由调用方固定。",
    "不得把短期条件、自我评价、关系称呼、偏好、能力、价值、凭证或模型推测改写成身份事实；currentState 只读。",
    "只引用快照内对应记忆自己的 sourceIds；没有证据时省略。只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
