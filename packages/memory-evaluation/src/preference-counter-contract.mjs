function clean(value) {
  return String(value ?? "").trim();
}

export const PREFERENCE_COUNTER_MATCH_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["analyses"],
  properties: {
    analyses: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "observationId", "memoryId", "sourceIds", "relation",
          "scopeOverlap", "temporalRelation", "confidence", "rationale",
        ],
        properties: {
          observationId: { type: "string", minLength: 1 },
          memoryId: { type: "string", minLength: 1 },
          sourceIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          relation: {
            type: "string",
            enum: [
              "same_scope_conflict", "subcategory_exception", "context_exception",
              "temporary_condition", "historical_only", "not_conflict", "unknown",
            ],
          },
          scopeOverlap: {
            type: "string",
            enum: ["exact", "subset", "partial", "disjoint", "unknown"],
          },
          temporalRelation: {
            type: "string",
            enum: ["overlaps_current", "predates_current", "future", "unknown"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
});

export const PREFERENCE_COUNTER_MATCH_CONTRACT = Object.freeze({
  role: "counter-evidence-match",
  schemaName: "memory-preference-counter-match-v1",
  promptVersion: "preference-counter-match-v1",
  promptFile: "preference-counter-match-system-prompt.md",
  schema: PREFERENCE_COUNTER_MATCH_SCHEMA,
});

const RELATIONS = PREFERENCE_COUNTER_MATCH_SCHEMA.properties.analyses.items.properties.relation.enum;
const SCOPE_OVERLAPS = PREFERENCE_COUNTER_MATCH_SCHEMA.properties.analyses.items.properties.scopeOverlap.enum;
const TEMPORAL_RELATIONS = PREFERENCE_COUNTER_MATCH_SCHEMA.properties.analyses.items.properties.temporalRelation.enum;

function enumValue(value, field, allowed) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) {
    throw new Error(`${field} has an unknown value: ${normalized || "(empty)"}.`);
  }
  return normalized;
}

export function parsePreferenceCounterMatchGeneration(value, { maximumAnalyses = 40 } = {}) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Preference counter matcher returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Preference counter matcher did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Preference counter matcher output requires an analyses array.");
  }
  const limit = Math.min(60, Math.max(0, Math.trunc(Number(maximumAnalyses) || 40)));
  if (parsed.analyses.length > limit) {
    throw new Error(`Preference counter matcher returned more than ${limit} analyses.`);
  }
  return {
    analyses: parsed.analyses.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Preference counter analysis ${index} must be an object.`);
      }
      const observationId = clean(item.observationId);
      const memoryId = clean(item.memoryId);
      const sourceIds = [...new Set(
        (Array.isArray(item.sourceIds) ? item.sourceIds : []).map(clean).filter(Boolean),
      )];
      const confidence = Number(item.confidence);
      const rationale = clean(item.rationale);
      if (!observationId || !memoryId || !sourceIds.length || !Number.isFinite(confidence)
        || confidence < 0 || confidence > 1 || !rationale) {
        throw new Error(`Preference counter analysis ${index} has an invalid envelope.`);
      }
      return {
        observationId,
        memoryId,
        sourceIds,
        relation: enumValue(item.relation, `analyses[${index}].relation`, RELATIONS),
        scopeOverlap: enumValue(
          item.scopeOverlap,
          `analyses[${index}].scopeOverlap`,
          SCOPE_OVERLAPS,
        ),
        temporalRelation: enumValue(
          item.temporalRelation,
          `analyses[${index}].temporalRelation`,
          TEMPORAL_RELATIONS,
        ),
        confidence,
        rationale,
      };
    }),
  };
}

export function buildPreferenceCounterMatchGenerationInput(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Preference counter matcher requires a bounded snapshot.");
  }
  return [
    "只比较当前偏好状态与每条待匹配反证是否在主体、对象、时间和适用范围上真正冲突。",
    "不得提出最终偏好等级，不得修改当前状态，不得引用快照外信息。",
    "只引用每个候选自己的 memoryId、observationId 和 sourceIds。证据不足时返回 unknown。",
    "只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
