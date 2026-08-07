function clean(value) { return String(value ?? "").trim(); }
const COMMON_REQUIRED = ["memoryId", "sourceIds", "confidence", "rationale"];
const COMMON_PROPERTIES = { memoryId: { type: "string", minLength: 1 },
  sourceIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
  confidence: { type: "number", minimum: 0, maximum: 1 }, rationale: { type: "string", minLength: 1 } };
function schema(required, properties) { return Object.freeze({ type: "object", additionalProperties: false,
  required: ["analyses"], properties: { analyses: { type: "array", maxItems: 80,
    items: { type: "object", additionalProperties: false, required: [...COMMON_REQUIRED, ...required],
      properties: { ...COMMON_PROPERTIES, ...properties } } } } }); }
export const AFFECTIVE_ASSOCIATION_ANALYZERS = Object.freeze({
  triggerEmotion: Object.freeze({ stateFamily: "affective_association", role: "trigger-emotion",
    schemaName: "memory-affective-trigger-emotion-v1", promptVersion: "affective-trigger-emotion-v1",
    promptFile: "affective-trigger-emotion-system-prompt.md",
    schema: schema(["targetMatch", "triggerType", "triggerLabel", "emotionLabel", "valence", "intensity"], {
      targetMatch: { type: "string", enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"] },
      triggerType: { type: "string", enum: ["person", "place", "event", "topic", "sensory", "object", "other", "unknown"] },
      triggerLabel: { type: "string" }, emotionLabel: { type: "string" },
      valence: { type: "string", enum: ["positive", "negative", "mixed", "neutral", "unknown"] },
      intensity: { type: "string", enum: ["low", "medium", "high", "unknown"] },
    }) }),
  experiencerAttribution: Object.freeze({ stateFamily: "affective_association", role: "experiencer-attribution",
    schemaName: "memory-affective-experiencer-v1", promptVersion: "affective-experiencer-v1",
    promptFile: "affective-experiencer-system-prompt.md",
    schema: schema(["experiencerMatch", "attribution"], {
      experiencerMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      attribution: { type: "string", enum: ["explicit_self_report", "explicit_reported_statement", "direct_observation", "third_party_interpretation", "model_inference", "quoted_or_roleplay", "unknown"] },
    }) }),
  associationBasis: Object.freeze({ stateFamily: "affective_association", role: "association-basis",
    schemaName: "memory-affective-association-basis-v1", promptVersion: "affective-association-basis-v1",
    promptFile: "affective-association-basis-system-prompt.md",
    schema: schema(["associationType", "causality", "recurrence"], {
      associationType: { type: "string", enum: ["explicit_trigger_link", "repeated_pattern", "single_cooccurrence", "current_mood", "general_preference", "no_affective_link", "unknown"] },
      causality: { type: "string", enum: ["explicit", "inferred", "none", "unknown"] },
      recurrence: { type: "string", enum: ["one_off", "repeated_claim", "stable_claim", "unknown"] },
    }) }),
  timeRevision: Object.freeze({ stateFamily: "affective_association", role: "time-revision",
    schemaName: "memory-affective-time-v2", promptVersion: "affective-time-v2",
    promptFile: "affective-time-system-prompt.md",
    schema: schema(["stateTime", "changeCue"], {
      stateTime: { type: "string", enum: ["current", "historical", "temporary", "future", "unknown"] },
      changeCue: { type: "string", enum: ["strengthened", "weakened", "extinguished", "emotion_changed", "clarified", "denies_prior_state", "none", "unknown"] },
    }) }),
  currentRelation: Object.freeze({ stateFamily: "affective_association", role: "current-relation",
    schemaName: "memory-affective-current-relation-v1", promptVersion: "affective-current-relation-v1",
    promptFile: "affective-current-relation-system-prompt.md",
    schema: schema(["currentStatePresent", "relation", "scopeOverlap"], {
      currentStatePresent: { type: "boolean" },
      relation: { type: "string", enum: ["no_current_state", "equivalent", "supports", "narrows", "broadens", "emotion_changed", "intensity_up", "intensity_down", "same_scope_conflict", "retires", "unrelated", "unknown"] },
      scopeOverlap: { type: "string", enum: ["exact", "partial", "none", "unknown"] },
    }) }),
});
function enumValue(value, field, allowed) { const text = clean(value); if (!allowed.includes(text)) throw new Error(`${field} has an unknown value: ${text || "(empty)"}.`); return text; }
function common(value, index) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Affective analysis ${index} must be an object.`);
  const memoryId = clean(value.memoryId); const sourceIds = [...new Set((Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean))];
  const confidence = Number(value.confidence); const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !rationale) throw new Error(`Affective analysis ${index} has an invalid common envelope.`);
  return { memoryId, sourceIds, confidence, rationale }; }
function parseItem(role, value, index) {
  const base = common(value, index);
  if (role === "trigger-emotion") return { ...base,
    targetMatch: enumValue(value.targetMatch, `analyses[${index}].targetMatch`, ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"]),
    triggerType: enumValue(value.triggerType, `analyses[${index}].triggerType`, ["person", "place", "event", "topic", "sensory", "object", "other", "unknown"]),
    triggerLabel: clean(value.triggerLabel), emotionLabel: clean(value.emotionLabel),
    valence: enumValue(value.valence, `analyses[${index}].valence`, ["positive", "negative", "mixed", "neutral", "unknown"]),
    intensity: enumValue(value.intensity, `analyses[${index}].intensity`, ["low", "medium", "high", "unknown"]) };
  if (role === "experiencer-attribution") return { ...base,
    experiencerMatch: enumValue(value.experiencerMatch, `analyses[${index}].experiencerMatch`, ["yes", "no", "unknown"]),
    attribution: enumValue(value.attribution, `analyses[${index}].attribution`, ["explicit_self_report", "explicit_reported_statement", "direct_observation", "third_party_interpretation", "model_inference", "quoted_or_roleplay", "unknown"]) };
  if (role === "association-basis") return { ...base,
    associationType: enumValue(value.associationType, `analyses[${index}].associationType`, ["explicit_trigger_link", "repeated_pattern", "single_cooccurrence", "current_mood", "general_preference", "no_affective_link", "unknown"]),
    causality: enumValue(value.causality, `analyses[${index}].causality`, ["explicit", "inferred", "none", "unknown"]),
    recurrence: enumValue(value.recurrence, `analyses[${index}].recurrence`, ["one_off", "repeated_claim", "stable_claim", "unknown"]) };
  if (role === "time-revision") return { ...base,
    stateTime: enumValue(value.stateTime, `analyses[${index}].stateTime`, ["current", "historical", "temporary", "future", "unknown"]),
    changeCue: enumValue(value.changeCue, `analyses[${index}].changeCue`, ["strengthened", "weakened", "extinguished", "emotion_changed", "clarified", "denies_prior_state", "none", "unknown"]) };
  if (role === "current-relation") { if (typeof value.currentStatePresent !== "boolean") throw new Error(`analyses[${index}].currentStatePresent must be boolean.`);
    return { ...base, currentStatePresent: value.currentStatePresent,
      relation: enumValue(value.relation, `analyses[${index}].relation`, ["no_current_state", "equivalent", "supports", "narrows", "broadens", "emotion_changed", "intensity_up", "intensity_down", "same_scope_conflict", "retires", "unrelated", "unknown"]),
      scopeOverlap: enumValue(value.scopeOverlap, `analyses[${index}].scopeOverlap`, ["exact", "partial", "none", "unknown"]) }; }
  throw new Error(`Unknown affective analyzer role: ${role || "(empty)"}.`);
}
export function parseAffectiveAssociationGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(AFFECTIVE_ASSOCIATION_ANALYZERS).some((item) => item.role === role)) throw new Error(`Unknown affective analyzer role: ${clean(role) || "(empty)"}.`);
  let parsed = value; if (typeof parsed === "string") { try { parsed = JSON.parse(parsed.replace(/^\uFEFF/u, "").trim()); } catch (error) { throw new Error(`Affective analyzer did not return valid JSON: ${error.message}`); } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.analyses)) throw new Error("Affective analyzer output requires an analyses array.");
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) throw new Error(`Affective analyzer returned more than ${limit} analyses.`);
  return { analyses: parsed.analyses.map((item, index) => parseItem(role, item, index)) };
}
export function buildAffectiveAssociationGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !definition?.role) throw new Error("Affective generation requires a snapshot and known analyzer.");
  return [`当前专职角色：${definition.role}。`, "只处理系统提示词规定的单一职责。主体、触发对象、canonicalKey、联结标签和候选记忆均由调用方固定。",
    "不得把当前心情、单次共现、偏好、关系或模型推测改写成稳定情绪联结；currentState 只读。",
    "只引用快照内对应记忆自己的 sourceIds；没有证据时省略。只输出符合 Schema 的 JSON。", "", JSON.stringify(snapshot, null, 2)].join("\n");
}
