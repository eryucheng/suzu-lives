function clean(value) {
  return String(value ?? "").trim();
}
const COMMON_REQUIRED = Object.freeze(["memoryId", "sourceIds", "confidence", "rationale"]);
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

export const GOAL_ANALYZERS = Object.freeze({
  targetIntent: Object.freeze({
    stateFamily: "goal",
    role: "target-intent",
    schemaName: "memory-goal-target-intent-v1",
    promptVersion: "goal-target-intent-v1",
    promptFile: "goal-target-intent-system-prompt.md",
    schema: resultSchema(["targetMatch", "goalText", "intentionLevel", "specificity"], {
      targetMatch: {
        type: "string",
        enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"],
      },
      goalText: { type: "string" },
      intentionLevel: {
        type: "string",
        enum: [
          "wish", "considering", "intention", "plan", "commitment",
          "open_loop", "external_requirement", "no_goal", "unknown",
        ],
      },
      specificity: { type: "string", enum: ["vague", "actionable", "unknown"] },
    }),
  }),
  holderResponsibility: Object.freeze({
    stateFamily: "goal",
    role: "holder-responsibility",
    schemaName: "memory-goal-holder-responsibility-v1",
    promptVersion: "goal-holder-responsibility-v1",
    promptFile: "goal-holder-responsibility-system-prompt.md",
    schema: resultSchema([
      "holderMatch", "attribution", "responsibility", "agency", "acceptsResponsibility",
    ], {
      holderMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      attribution: {
        type: "string",
        enum: [
          "explicit_self_statement", "explicit_reported_statement", "third_party_attribution",
          "agent_inference", "quoted_or_roleplay", "unknown",
        ],
      },
      responsibility: { type: "string", enum: ["subject", "shared", "other", "unknown"] },
      agency: { type: "string", enum: ["self_chosen", "shared_agreement", "external_requirement", "unknown"] },
      acceptsResponsibility: { type: "string", enum: ["yes", "no", "unknown"] },
    }),
  }),
  lifecycle: Object.freeze({
    stateFamily: "goal",
    role: "lifecycle",
    schemaName: "memory-goal-lifecycle-v1",
    promptVersion: "goal-lifecycle-v1",
    promptFile: "goal-lifecycle-system-prompt.md",
    schema: resultSchema(["lifecycle", "completionBasis", "timeReference"], {
      lifecycle: {
        type: "string",
        enum: [
          "active", "in_progress", "blocked", "paused", "completed", "cancelled",
          "abandoned", "historical", "future", "unknown",
        ],
      },
      completionBasis: {
        type: "string",
        enum: ["explicit_self_report", "direct_result", "direct_cancellation", "inferred", "none", "unknown"],
      },
      timeReference: { type: "string" },
    }),
  }),
  currentRelation: Object.freeze({
    stateFamily: "goal",
    role: "current-relation",
    schemaName: "memory-goal-current-relation-v1",
    promptVersion: "goal-current-relation-v1",
    promptFile: "goal-current-relation-system-prompt.md",
    schema: resultSchema(["currentStatePresent", "relation"], {
      currentStatePresent: { type: "boolean" },
      relation: {
        type: "string",
        enum: [
          "no_current_state", "same_goal", "progress_update", "pauses", "resumes",
          "completes", "cancels", "narrower_step", "broader_goal", "replaces",
          "conflict", "unrelated", "unknown",
        ],
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
    throw new Error(`Goal analysis ${index} must be an object.`);
  }
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set(
    (Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean),
  )];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Goal analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "target-intent") {
    return {
      ...common,
      targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, [
        "exact", "subcategory", "broader_category", "contextual", "none", "unknown",
      ]),
      goalText: clean(value.goalText),
      intentionLevel: requireEnum(value.intentionLevel, `analyses[${index}].intentionLevel`, [
        "wish", "considering", "intention", "plan", "commitment",
        "open_loop", "external_requirement", "no_goal", "unknown",
      ]),
      specificity: requireEnum(value.specificity, `analyses[${index}].specificity`, ["vague", "actionable", "unknown"]),
    };
  }
  if (role === "holder-responsibility") {
    return {
      ...common,
      holderMatch: requireEnum(value.holderMatch, `analyses[${index}].holderMatch`, ["yes", "no", "unknown"]),
      attribution: requireEnum(value.attribution, `analyses[${index}].attribution`, [
        "explicit_self_statement", "explicit_reported_statement", "third_party_attribution",
        "agent_inference", "quoted_or_roleplay", "unknown",
      ]),
      responsibility: requireEnum(value.responsibility, `analyses[${index}].responsibility`, ["subject", "shared", "other", "unknown"]),
      agency: requireEnum(value.agency, `analyses[${index}].agency`, ["self_chosen", "shared_agreement", "external_requirement", "unknown"]),
      acceptsResponsibility: requireEnum(value.acceptsResponsibility, `analyses[${index}].acceptsResponsibility`, ["yes", "no", "unknown"]),
    };
  }
  if (role === "lifecycle") {
    return {
      ...common,
      lifecycle: requireEnum(value.lifecycle, `analyses[${index}].lifecycle`, [
        "active", "in_progress", "blocked", "paused", "completed", "cancelled",
        "abandoned", "historical", "future", "unknown",
      ]),
      completionBasis: requireEnum(value.completionBasis, `analyses[${index}].completionBasis`, [
        "explicit_self_report", "direct_result", "direct_cancellation", "inferred", "none", "unknown",
      ]),
      timeReference: clean(value.timeReference),
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
        "no_current_state", "same_goal", "progress_update", "pauses", "resumes",
        "completes", "cancels", "narrower_step", "broader_goal", "replaces",
        "conflict", "unrelated", "unknown",
      ]),
    };
  }
  throw new Error(`Unknown goal analyzer role: ${role || "(empty)"}.`);
}

export function parseGoalGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(GOAL_ANALYZERS).some((definition) => definition.role === role)) {
    throw new Error(`Unknown goal analyzer role: ${clean(role) || "(empty)"}.`);
  }
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Goal analyzer returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Goal analyzer did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Goal analyzer output requires an analyses array.");
  }
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) {
    throw new Error(`Goal analyzer returned more than ${limit} analyses.`);
  }
  return { analyses: parsed.analyses.map((item, index) => parseRoleItem(role, item, index)) };
}

export function buildGoalGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Goal generation requires a snapshot object.");
  }
  if (!definition?.role) throw new Error("Goal generation requires a known analyzer definition.");
  return [
    `当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责，不要替其他专职角色作结论。",
    "目标主体、canonicalKey、目标名称和候选记忆由调用方固定；不得改变主体、发现新任务或扫描快照外信息。",
    "currentState 只读；不得创建任务、写记忆、设置提醒或改变生命周期。",
    "只引用快照内对应记忆自己的 sourceIds。没有证据时省略该记忆，不要猜测补齐。",
    "只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
