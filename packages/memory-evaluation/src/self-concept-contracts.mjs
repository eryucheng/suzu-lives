function clean(value) { return String(value ?? "").trim(); }
const COMMON_REQUIRED = ["memoryId", "sourceIds", "confidence", "rationale"];
const COMMON_PROPERTIES = {
  memoryId: { type: "string", minLength: 1 },
  sourceIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  rationale: { type: "string", minLength: 1 },
};
function resultSchema(required, properties) {
  return Object.freeze({ type: "object", additionalProperties: false, required: ["analyses"], properties: {
    analyses: { type: "array", maxItems: 80, items: { type: "object", additionalProperties: false,
      required: [...COMMON_REQUIRED, ...required], properties: { ...COMMON_PROPERTIES, ...properties } } },
  } });
}

export const SELF_CONCEPT_ANALYZERS = Object.freeze({
  conceptGrounding: Object.freeze({
    stateFamily: "self_concept", role: "concept-grounding",
    schemaName: "memory-self-concept-grounding-v1", promptVersion: "self-concept-grounding-v1",
    promptFile: "self-concept-grounding-system-prompt.md",
    schema: resultSchema(["targetMatch", "conceptType", "conceptLabel", "scopeLabel"], {
      targetMatch: { type: "string", enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"] },
      conceptType: { type: "string", enum: ["self_description", "role_identity", "narrative_theme", "personal_standard", "self_efficacy", "other", "unknown"] },
      conceptLabel: { type: "string" }, scopeLabel: { type: "string" },
    }),
  }),
  holderAttribution: Object.freeze({
    stateFamily: "self_concept", role: "holder-attribution",
    schemaName: "memory-self-concept-holder-v1", promptVersion: "self-concept-holder-v1",
    promptFile: "self-concept-holder-system-prompt.md",
    schema: resultSchema(["holderMatch", "attribution"], {
      holderMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      attribution: { type: "string", enum: ["explicit_self_definition", "explicit_self_reflection", "explicit_reported_statement", "third_party_attribution", "model_inference", "quoted_or_roleplay", "unknown"] },
    }),
  }),
  stabilityContext: Object.freeze({
    stateFamily: "self_concept", role: "stability-context",
    schemaName: "memory-self-concept-stability-v1", promptVersion: "self-concept-stability-v1",
    promptFile: "self-concept-stability-system-prompt.md",
    schema: resultSchema(["expressionType", "contextBasis"], {
      expressionType: { type: "string", enum: ["stable_self_definition", "reflective_reinterpretation", "temporary_self_appraisal", "contextual_role", "identity_fact", "no_self_concept", "unknown"] },
      contextBasis: { type: "string", enum: ["repeated_reflection", "turning_point", "single_reflection", "acute_emotion", "roleplay", "factual_record", "unknown"] },
    }),
  }),
  timeRevision: Object.freeze({
    stateFamily: "self_concept", role: "time-revision",
    schemaName: "memory-self-concept-time-v1", promptVersion: "self-concept-time-v1",
    promptFile: "self-concept-time-system-prompt.md",
    schema: resultSchema(["stateTime", "revisionCue"], {
      stateTime: { type: "string", enum: ["current", "historical", "temporary", "future", "unknown"] },
      revisionCue: { type: "string", enum: ["changed", "clarified", "never_held", "none", "unknown"] },
    }),
  }),
  currentRelation: Object.freeze({
    stateFamily: "self_concept", role: "current-relation",
    schemaName: "memory-self-concept-current-relation-v1", promptVersion: "self-concept-current-relation-v1",
    promptFile: "self-concept-current-relation-system-prompt.md",
    schema: resultSchema(["currentStatePresent", "relation", "scopeOverlap"], {
      currentStatePresent: { type: "boolean" },
      relation: { type: "string", enum: ["no_current_state", "equivalent", "supports", "narrows", "broadens", "same_scope_conflict", "replaces", "corrects_attribution", "unrelated", "unknown"] },
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Self-concept analysis ${index} must be an object.`);
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set((Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean))];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !rationale) throw new Error(`Self-concept analysis ${index} has an invalid common envelope.`);
  return { memoryId, sourceIds, confidence, rationale };
}
function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "concept-grounding") return { ...common,
    targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"]),
    conceptType: requireEnum(value.conceptType, `analyses[${index}].conceptType`, ["self_description", "role_identity", "narrative_theme", "personal_standard", "self_efficacy", "other", "unknown"]),
    conceptLabel: clean(value.conceptLabel), scopeLabel: clean(value.scopeLabel) };
  if (role === "holder-attribution") return { ...common,
    holderMatch: requireEnum(value.holderMatch, `analyses[${index}].holderMatch`, ["yes", "no", "unknown"]),
    attribution: requireEnum(value.attribution, `analyses[${index}].attribution`, ["explicit_self_definition", "explicit_self_reflection", "explicit_reported_statement", "third_party_attribution", "model_inference", "quoted_or_roleplay", "unknown"]) };
  if (role === "stability-context") return { ...common,
    expressionType: requireEnum(value.expressionType, `analyses[${index}].expressionType`, ["stable_self_definition", "reflective_reinterpretation", "temporary_self_appraisal", "contextual_role", "identity_fact", "no_self_concept", "unknown"]),
    contextBasis: requireEnum(value.contextBasis, `analyses[${index}].contextBasis`, ["repeated_reflection", "turning_point", "single_reflection", "acute_emotion", "roleplay", "factual_record", "unknown"]) };
  if (role === "time-revision") return { ...common,
    stateTime: requireEnum(value.stateTime, `analyses[${index}].stateTime`, ["current", "historical", "temporary", "future", "unknown"]),
    revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, ["changed", "clarified", "never_held", "none", "unknown"]) };
  if (role === "current-relation") {
    if (typeof value.currentStatePresent !== "boolean") throw new Error(`analyses[${index}].currentStatePresent must be boolean.`);
    return { ...common, currentStatePresent: value.currentStatePresent,
      relation: requireEnum(value.relation, `analyses[${index}].relation`, ["no_current_state", "equivalent", "supports", "narrows", "broadens", "same_scope_conflict", "replaces", "corrects_attribution", "unrelated", "unknown"]),
      scopeOverlap: requireEnum(value.scopeOverlap, `analyses[${index}].scopeOverlap`, ["exact", "partial", "none", "unknown"]) };
  }
  throw new Error(`Unknown self-concept analyzer role: ${role || "(empty)"}.`);
}
export function parseSelfConceptGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(SELF_CONCEPT_ANALYZERS).some((item) => item.role === role)) throw new Error(`Unknown self-concept analyzer role: ${clean(role) || "(empty)"}.`);
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed.replace(/^\uFEFF/u, "").trim()); } catch (error) { throw new Error(`Self-concept analyzer did not return valid JSON: ${error.message}`); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.analyses)) throw new Error("Self-concept analyzer output requires an analyses array.");
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) throw new Error(`Self-concept analyzer returned more than ${limit} analyses.`);
  return { analyses: parsed.analyses.map((item, index) => parseRoleItem(role, item, index)) };
}
export function buildSelfConceptGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !definition?.role) throw new Error("Self-concept generation requires a snapshot and known analyzer.");
  return [
    `当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责。主体、canonicalKey、自我认识标签和候选记忆均由调用方固定。",
    "不得把客观身份、临时情绪、第三方标签、行为倾向或模型总结改写成主体的自我认识；currentState 只读。",
    "只引用快照内对应记忆自己的 sourceIds；没有证据时省略。只输出符合 Schema 的 JSON。",
    "", JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
