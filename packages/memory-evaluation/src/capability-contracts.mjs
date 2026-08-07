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

export const CAPABILITY_ANALYZERS = Object.freeze({
  skillGrounding: Object.freeze({
    stateFamily: "capability", role: "skill-grounding",
    schemaName: "memory-capability-skill-grounding-v1", promptVersion: "capability-skill-grounding-v1",
    promptFile: "capability-skill-grounding-system-prompt.md",
    schema: resultSchema(["targetMatch", "skillLabel", "scopeLabel", "taskDifficulty"], {
      targetMatch: { type: "string", enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"] },
      skillLabel: { type: "string" },
      scopeLabel: { type: "string" },
      taskDifficulty: { type: "string", enum: ["trivial", "basic", "intermediate", "advanced", "expert", "unknown"] },
    }),
  }),
  holderAttribution: Object.freeze({
    stateFamily: "capability", role: "holder-attribution",
    schemaName: "memory-capability-holder-attribution-v1", promptVersion: "capability-holder-attribution-v1",
    promptFile: "capability-holder-attribution-system-prompt.md",
    schema: resultSchema(["holderMatch", "attribution"], {
      holderMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      attribution: { type: "string", enum: ["explicit_self_statement", "direct_observation", "explicit_reported_statement", "third_party_attribution", "model_inference", "quoted_or_roleplay", "unknown"] },
    }),
  }),
  performanceEvidence: Object.freeze({
    stateFamily: "capability", role: "performance-evidence",
    schemaName: "memory-capability-performance-evidence-v1", promptVersion: "capability-performance-evidence-v1",
    promptFile: "capability-performance-evidence-system-prompt.md",
    schema: resultSchema(["evidenceType", "outcome", "proficiencyClaim", "failureCause"], {
      evidenceType: { type: "string", enum: ["self_report", "demonstrated_result", "failed_attempt", "training_or_instruction", "tool_availability", "interest_only", "no_capability", "unknown"] },
      outcome: { type: "string", enum: ["success", "partial", "failure", "no_result", "unknown"] },
      proficiencyClaim: { type: "string", enum: ["novice", "basic", "competent", "advanced", "expert", "none", "unknown"] },
      failureCause: { type: "string", enum: ["skill_gap", "environment", "tool_failure", "external_constraint", "not_applicable", "unknown"] },
    }),
  }),
  independenceConditions: Object.freeze({
    stateFamily: "capability", role: "independence-conditions",
    schemaName: "memory-capability-independence-conditions-v1", promptVersion: "capability-independence-conditions-v1",
    promptFile: "capability-independence-conditions-system-prompt.md",
    schema: resultSchema(["independence", "dependencyLabel", "repeatability", "conditionLabel"], {
      independence: { type: "string", enum: ["independent", "assisted", "tool_dependent", "not_applicable", "unknown"] },
      dependencyLabel: { type: "string" },
      repeatability: { type: "string", enum: ["one_off", "repeated_claim", "stable_claim", "not_applicable", "unknown"] },
      conditionLabel: { type: "string" },
    }),
  }),
  timeCurrentRelation: Object.freeze({
    stateFamily: "capability", role: "time-current-relation",
    schemaName: "memory-capability-time-current-relation-v1", promptVersion: "capability-time-current-relation-v1",
    promptFile: "capability-time-current-relation-system-prompt.md",
    schema: resultSchema(["stateTime", "changeCue", "currentStatePresent", "relation", "scopeOverlap"], {
      stateTime: { type: "string", enum: ["current", "historical", "future", "unknown"] },
      changeCue: { type: "string", enum: ["improved", "declined", "lost", "none", "unknown"] },
      currentStatePresent: { type: "boolean" },
      relation: { type: "string", enum: ["no_current_state", "equivalent", "supports", "narrows", "broadens", "proficiency_up", "proficiency_down", "same_scope_conflict", "retires", "unrelated", "unknown"] },
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Capability analysis ${index} must be an object.`);
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set((Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean))];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Capability analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "skill-grounding") return {
    ...common,
    targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"]),
    skillLabel: clean(value.skillLabel), scopeLabel: clean(value.scopeLabel),
    taskDifficulty: requireEnum(value.taskDifficulty, `analyses[${index}].taskDifficulty`, ["trivial", "basic", "intermediate", "advanced", "expert", "unknown"]),
  };
  if (role === "holder-attribution") return {
    ...common,
    holderMatch: requireEnum(value.holderMatch, `analyses[${index}].holderMatch`, ["yes", "no", "unknown"]),
    attribution: requireEnum(value.attribution, `analyses[${index}].attribution`, ["explicit_self_statement", "direct_observation", "explicit_reported_statement", "third_party_attribution", "model_inference", "quoted_or_roleplay", "unknown"]),
  };
  if (role === "performance-evidence") return {
    ...common,
    evidenceType: requireEnum(value.evidenceType, `analyses[${index}].evidenceType`, ["self_report", "demonstrated_result", "failed_attempt", "training_or_instruction", "tool_availability", "interest_only", "no_capability", "unknown"]),
    outcome: requireEnum(value.outcome, `analyses[${index}].outcome`, ["success", "partial", "failure", "no_result", "unknown"]),
    proficiencyClaim: requireEnum(value.proficiencyClaim, `analyses[${index}].proficiencyClaim`, ["novice", "basic", "competent", "advanced", "expert", "none", "unknown"]),
    failureCause: requireEnum(value.failureCause, `analyses[${index}].failureCause`, ["skill_gap", "environment", "tool_failure", "external_constraint", "not_applicable", "unknown"]),
  };
  if (role === "independence-conditions") return {
    ...common,
    independence: requireEnum(value.independence, `analyses[${index}].independence`, ["independent", "assisted", "tool_dependent", "not_applicable", "unknown"]),
    dependencyLabel: clean(value.dependencyLabel),
    repeatability: requireEnum(value.repeatability, `analyses[${index}].repeatability`, ["one_off", "repeated_claim", "stable_claim", "not_applicable", "unknown"]),
    conditionLabel: clean(value.conditionLabel),
  };
  if (role === "time-current-relation") {
    if (typeof value.currentStatePresent !== "boolean") throw new Error(`analyses[${index}].currentStatePresent must be boolean.`);
    return {
      ...common,
      stateTime: requireEnum(value.stateTime, `analyses[${index}].stateTime`, ["current", "historical", "future", "unknown"]),
      changeCue: requireEnum(value.changeCue, `analyses[${index}].changeCue`, ["improved", "declined", "lost", "none", "unknown"]),
      currentStatePresent: value.currentStatePresent,
      relation: requireEnum(value.relation, `analyses[${index}].relation`, ["no_current_state", "equivalent", "supports", "narrows", "broadens", "proficiency_up", "proficiency_down", "same_scope_conflict", "retires", "unrelated", "unknown"]),
      scopeOverlap: requireEnum(value.scopeOverlap, `analyses[${index}].scopeOverlap`, ["exact", "partial", "none", "unknown"]),
    };
  }
  throw new Error(`Unknown capability analyzer role: ${role || "(empty)"}.`);
}

export function parseCapabilityGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(CAPABILITY_ANALYZERS).some((item) => item.role === role)) throw new Error(`Unknown capability analyzer role: ${clean(role) || "(empty)"}.`);
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed.replace(/^\uFEFF/u, "").trim()); } catch (error) { throw new Error(`Capability analyzer did not return valid JSON: ${error.message}`); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.analyses)) throw new Error("Capability analyzer output requires an analyses array.");
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) throw new Error(`Capability analyzer returned more than ${limit} analyses.`);
  return { analyses: parsed.analyses.map((item, index) => parseRoleItem(role, item, index)) };
}

export function buildCapabilityGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !definition?.role) throw new Error("Capability generation requires a snapshot and known analyzer.");
  return [
    `当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责。主体、canonicalKey、能力标签和候选记忆均由调用方固定。",
    "不得把兴趣、目标、工具存在、教程或一次结果扩大成稳定熟练度；currentState 只读。",
    "只引用快照内对应记忆自己的 sourceIds；没有证据时省略。只输出符合 Schema 的 JSON。",
    "", JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
