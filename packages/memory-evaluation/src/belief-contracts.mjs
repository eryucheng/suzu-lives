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

export const BELIEF_ANALYZERS = Object.freeze({
  propositionGrounding: Object.freeze({
    stateFamily: "belief",
    role: "proposition-grounding",
    schemaName: "memory-belief-proposition-grounding-v1",
    promptVersion: "belief-proposition-grounding-v1",
    promptFile: "belief-proposition-grounding-system-prompt.md",
    schema: resultSchema([
      "targetMatch",
      "claimText",
      "stance",
      "claimKind",
      "quantifier",
    ], {
      targetMatch: {
        type: "string",
        enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"],
      },
      claimText: { type: "string" },
      stance: { type: "string", enum: ["asserts", "denies", "uncertain", "mixed", "no_claim", "unknown"] },
      claimKind: {
        type: "string",
        enum: ["opinion", "interpretation", "expectation", "factual_claim", "value_judgment", "unknown"],
      },
      quantifier: { type: "string", enum: ["universal", "general", "some", "specific", "unknown"] },
    }),
  }),
  holderAttribution: Object.freeze({
    stateFamily: "belief",
    role: "holder-attribution",
    schemaName: "memory-belief-holder-attribution-v1",
    promptVersion: "belief-holder-attribution-v1",
    promptFile: "belief-holder-attribution-system-prompt.md",
    schema: resultSchema(["holderMatch", "attribution"], {
      holderMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      attribution: {
        type: "string",
        enum: [
          "explicit_self_statement", "explicit_reported_statement", "third_party_attribution",
          "agent_inference", "quoted_or_roleplay", "no_holder", "unknown",
        ],
      },
    }),
  }),
  timeRevision: Object.freeze({
    stateFamily: "belief",
    role: "time-revision",
    schemaName: "memory-belief-time-revision-v1",
    promptVersion: "belief-time-revision-v1",
    promptFile: "belief-time-revision-system-prompt.md",
    schema: resultSchema(["stateTime", "revisionCue", "timeReference"], {
      stateTime: { type: "string", enum: ["current", "historical", "future", "timeless", "unknown"] },
      revisionCue: {
        type: "string",
        enum: [
          "maintains", "changed_mind", "revises_scope", "retracts_current",
          "denies_prior_holding", "none", "unknown",
        ],
      },
      timeReference: { type: "string" },
    }),
  }),
  currentRelation: Object.freeze({
    stateFamily: "belief",
    role: "current-relation",
    schemaName: "memory-belief-current-relation-v1",
    promptVersion: "belief-current-relation-v1",
    promptFile: "belief-current-relation-system-prompt.md",
    schema: resultSchema(["currentStatePresent", "relation", "scopeOverlap"], {
      currentStatePresent: { type: "boolean" },
      relation: {
        type: "string",
        enum: [
          "no_current_state", "equivalent", "supports", "narrows", "broadens",
          "partial_exception", "same_scope_conflict", "retracts", "unrelated", "unknown",
        ],
      },
      scopeOverlap: { type: "string", enum: ["exact", "subcategory", "broader", "partial", "none", "unknown"] },
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
    throw new Error(`Belief analysis ${index} must be an object.`);
  }
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set(
    (Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean),
  )];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Belief analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "proposition-grounding") {
    return {
      ...common,
      targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, [
        "exact", "subcategory", "broader_category", "contextual", "none", "unknown",
      ]),
      claimText: clean(value.claimText),
      stance: requireEnum(value.stance, `analyses[${index}].stance`, [
        "asserts", "denies", "uncertain", "mixed", "no_claim", "unknown",
      ]),
      claimKind: requireEnum(value.claimKind, `analyses[${index}].claimKind`, [
        "opinion", "interpretation", "expectation", "factual_claim", "value_judgment", "unknown",
      ]),
      quantifier: requireEnum(value.quantifier, `analyses[${index}].quantifier`, [
        "universal", "general", "some", "specific", "unknown",
      ]),
    };
  }
  if (role === "holder-attribution") {
    return {
      ...common,
      holderMatch: requireEnum(value.holderMatch, `analyses[${index}].holderMatch`, ["yes", "no", "unknown"]),
      attribution: requireEnum(value.attribution, `analyses[${index}].attribution`, [
        "explicit_self_statement", "explicit_reported_statement", "third_party_attribution",
        "agent_inference", "quoted_or_roleplay", "no_holder", "unknown",
      ]),
    };
  }
  if (role === "time-revision") {
    return {
      ...common,
      stateTime: requireEnum(value.stateTime, `analyses[${index}].stateTime`, [
        "current", "historical", "future", "timeless", "unknown",
      ]),
      revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, [
        "maintains", "changed_mind", "revises_scope", "retracts_current",
        "denies_prior_holding", "none", "unknown",
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
        "no_current_state", "equivalent", "supports", "narrows", "broadens",
        "partial_exception", "same_scope_conflict", "retracts", "unrelated", "unknown",
      ]),
      scopeOverlap: requireEnum(value.scopeOverlap, `analyses[${index}].scopeOverlap`, [
        "exact", "subcategory", "broader", "partial", "none", "unknown",
      ]),
    };
  }
  throw new Error(`Unknown belief analyzer role: ${role || "(empty)"}.`);
}

export function parseBeliefGeneration(role, value, { maximumAnalyses = 60 } = {}) {
  if (!Object.values(BELIEF_ANALYZERS).some((definition) => definition.role === role)) {
    throw new Error(`Unknown belief analyzer role: ${clean(role) || "(empty)"}.`);
  }
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Belief analyzer returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Belief analyzer did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Belief analyzer output requires an analyses array.");
  }
  const limit = Math.min(80, Math.max(0, Math.trunc(Number(maximumAnalyses) || 60)));
  if (parsed.analyses.length > limit) {
    throw new Error(`Belief analyzer returned more than ${limit} analyses.`);
  }
  return { analyses: parsed.analyses.map((item, index) => parseRoleItem(role, item, index)) };
}

export function buildBeliefGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Belief generation requires a snapshot object.");
  }
  if (!definition?.role) throw new Error("Belief generation requires a known analyzer definition.");
  return [
    `当前专职角色：${definition.role}。`,
    "只处理系统提示词规定的单一职责，不要替其他专职角色作结论。",
    "目标主体、canonicalKey、目标主题和候选记忆由调用方固定；不得改变主体、创造新目标或扫描快照外信息。",
    "currentState 只读；不得决定写库、关闭旧状态或创建关系边。",
    "只引用快照内对应记忆自己的 sourceIds。没有证据时省略该记忆，不要猜测补齐。",
    "只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}
