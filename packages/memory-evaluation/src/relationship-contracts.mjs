function clean(value) { return String(value ?? "").trim(); }

const COMMON_REQUIRED = ["memoryId", "sourceIds", "confidence", "rationale"];
const COMMON_PROPERTIES = {
  memoryId: { type: "string", minLength: 1 },
  sourceIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
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
export const RELATIONSHIP_ANALYZERS = Object.freeze({
  relationGrounding: Object.freeze({
    stateFamily: "relationship", role: "relation-grounding",
    schemaName: "memory-relationship-grounding-v1", promptVersion: "relationship-grounding-v1",
    promptFile: "relationship-grounding-system-prompt.md",
    schema: resultSchema(["targetMatch", "relationType", "polarity", "relationLabel", "scopeLabel", "conditionLabel"], {
      targetMatch: { type: "string", enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"] },
      relationType: { type: "string", enum: ["role", "naming", "trust", "boundary", "permission", "expectation", "closeness", "agreement", "support", "other", "unknown"] },
      polarity: { type: "string", enum: ["affirms", "denies", "sets", "withdraws", "conditional", "uncertain", "no_relation", "unknown"] },
      relationLabel: { type: "string" },
      scopeLabel: { type: "string" },
      conditionLabel: { type: "string" },
    }),
  }),
  perspectiveDirection: Object.freeze({
    stateFamily: "relationship", role: "perspective-direction",
    schemaName: "memory-relationship-perspective-v1", promptVersion: "relationship-perspective-v1",
    promptFile: "relationship-perspective-system-prompt.md",
    schema: resultSchema(["holderMatch", "counterpartMatch", "direction", "attribution"], {
      holderMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      counterpartMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      direction: { type: "string", enum: ["holder_to_counterpart", "counterpart_to_holder", "mutual_claim", "about_pair", "unknown"] },
      attribution: { type: "string", enum: ["explicit_self_statement", "explicit_reported_statement", "third_party_attribution", "agent_inference", "quoted_or_roleplay", "unknown"] },
    }),
  }),
  scopeTime: Object.freeze({
    stateFamily: "relationship", role: "scope-time",
    schemaName: "memory-relationship-scope-time-v1", promptVersion: "relationship-scope-time-v1",
    promptFile: "relationship-scope-time-system-prompt.md",
    schema: resultSchema(["stateTime", "duration", "revocationCue"], {
      stateTime: { type: "string", enum: ["current", "historical", "temporary", "future", "unknown"] },
      duration: { type: "string", enum: ["ongoing", "temporary", "one_time", "ended", "unknown"] },
      revocationCue: { type: "string", enum: ["explicit", "none", "unknown"] },
    }),
  }),
  currentRelation: Object.freeze({
    stateFamily: "relationship", role: "current-relation",
    schemaName: "memory-relationship-current-relation-v1", promptVersion: "relationship-current-relation-v1",
    promptFile: "relationship-current-relation-system-prompt.md",
    schema: resultSchema(["currentStatePresent", "relation", "scopeOverlap"], {
      currentStatePresent: { type: "boolean" },
      relation: { type: "string", enum: ["no_current_state", "equivalent", "supports", "narrows", "broadens", "same_scope_conflict", "revokes", "replaces", "unrelated", "unknown"] },
      scopeOverlap: { type: "string", enum: ["exact", "partial", "none", "unknown"] },
    }),
  }),
});

function requireEnum(value, field, allowed) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) throw new Error(`${field} has an unknown value: ${normalized || "(empty)"}.`);
  return normalized;
}

function parseCommon(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Relationship analysis ${index} must be an object.`);
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set((Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean))];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Relationship analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "relation-grounding") return {
    ...common,
    targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"]),
    relationType: requireEnum(value.relationType, `analyses[${index}].relationType`, ["role", "naming", "trust", "boundary", "permission", "expectation", "closeness", "agreement", "support", "other", "unknown"]),
    polarity: requireEnum(value.polarity, `analyses[${index}].polarity`, ["affirms", "denies", "sets", "withdraws", "conditional", "uncertain", "no_relation", "unknown"]),
    relationLabel: clean(value.relationLabel), scopeLabel: clean(value.scopeLabel), conditionLabel: clean(value.conditionLabel),
  };
  if (role === "perspective-direction") return {
    ...common,
    holderMatch: requireEnum(value.holderMatch, `analyses[${index}].holderMatch`, ["yes", "no", "unknown"]),
    counterpartMatch: requireEnum(value.counterpartMatch, `analyses[${index}].counterpartMatch`, ["yes", "no", "unknown"]),
    direction: requireEnum(value.direction, `analyses[${index}].direction`, ["holder_to_counterpart", "counterpart_to_holder", "mutual_claim", "about_pair", "unknown"]),
    attribution: requireEnum(value.attribution, `analyses[${index}].attribution`, ["explicit_self_statement", "explicit_reported_statement", "third_party_attribution", "agent_inference", "quoted_or_roleplay", "unknown"]),
  };
  if (role === "scope-time") return {
    ...common,
    stateTime: requireEnum(value.stateTime, `analyses[${index}].stateTime`, ["current", "historical", "temporary", "future", "unknown"]),
    duration: requireEnum(value.duration, `analyses[${index}].duration`, ["ongoing", "temporary", "one_time", "ended", "unknown"]),
    revocationCue: requireEnum(value.revocationCue, `analyses[${index}].revocationCue`, ["explicit", "none", "unknown"]),
  };
  if (role === "current-relation") {
    if (typeof value.currentStatePresent !== "boolean") throw new Error(`analyses[${index}].currentStatePresent must be boolean.`);
    return {
      ...common, currentStatePresent: value.currentStatePresent,
      relation: requireEnum(value.relation, `analyses[${index}].relation`, ["no_current_state", "equivalent", "supports", "narrows", "broadens", "same_scope_conflict", "revokes", "replaces", "unrelated", "unknown"]),
      scopeOverlap: requireEnum(value.scopeOverlap, `analyses[${index}].scopeOverlap`, ["exact", "partial", "none", "unknown"]),
    };
  }
  throw new Error(`Unknown relationship analyzer role: ${role || "(empty)"}.`);
}

export function parseRelationshipGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(RELATIONSHIP_ANALYZERS).some((item) => item.role === role)) throw new Error(`Unknown relationship analyzer role: ${clean(role) || "(empty)"}.`);
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed.replace(/^\uFEFF/u, "").trim()); } catch (error) { throw new Error(`Relationship analyzer did not return valid JSON: ${error.message}`); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.analyses)) throw new Error("Relationship analyzer output requires an analyses array.");
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) throw new Error(`Relationship analyzer returned more than ${limit} analyses.`);
  return { analyses: parsed.analyses.map((item, index) => parseRoleItem(role, item, index)) };
}

export function buildRelationshipGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !definition?.role) throw new Error("Relationship generation requires a snapshot and known analyzer.");
  return [
    `当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责。持有者、对方、canonicalKey、关系标签和候选记忆均由调用方固定。",
    "不得把反方向关系、第三方评价或单方对双方的声称改写成共同关系。currentState 只读。",
    "只引用快照内对应记忆自己的 sourceIds；没有证据时省略。只输出符合 Schema 的 JSON。",
    "", JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
