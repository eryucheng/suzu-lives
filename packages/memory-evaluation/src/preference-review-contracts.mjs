function clean(value) {
  return String(value ?? "").trim();
}

const LEVELS = Object.freeze([
  "situational_tolerance", "selection_tendency", "stable_preference",
  "direct_preference", "explicit_rejection", "no_conclusion",
]);

const ACTIONS = Object.freeze([
  "maintain", "create", "reinforce", "promote", "downgrade",
  "narrow_scope", "replace_explicit", "no_conclusion", "review_required",
]);

const TREATMENTS = Object.freeze([
  "positive_preference_evidence", "negative_preference_evidence",
  "scope_exception", "uncertain",
]);

export const PREFERENCE_STATE_SYNTHESIS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "action", "proposedLevel", "scopeChange", "scope",
    "evidenceDecisions", "confidence", "rationale",
  ],
  properties: {
    action: { type: "string", enum: ACTIONS },
    proposedLevel: { type: "string", enum: LEVELS },
    scopeChange: { type: "string", enum: ["none", "narrow", "replace", "unknown"] },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "context"],
      properties: {
        kind: { type: "string" },
        label: { type: "string" },
        context: { type: "string" },
      },
    },
    evidenceDecisions: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["observationId", "treatment", "rationale"],
        properties: {
          observationId: { type: "string", minLength: 1 },
          treatment: { type: "string", enum: TREATMENTS },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", minLength: 1 },
  },
});

export const PREFERENCE_STATE_CRITIC_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "summary"],
  properties: {
    verdict: { type: "string", enum: ["approve_shadow", "revise", "human_review"] },
    issues: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "observationIds", "rationale"],
        properties: {
          code: {
            type: "string",
            enum: [
              "subject_mismatch", "temporal_error", "scope_overreach",
              "constraint_ignored", "counterevidence_omitted", "duplicate_evidence",
              "unsupported_transition", "unsupported_claim", "insufficient_evidence",
              "unresolved_conflict", "other",
            ],
          },
          severity: { type: "string", enum: ["critical", "warning"] },
          observationIds: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
    summary: { type: "string", minLength: 1 },
  },
});

export const PREFERENCE_REVIEW_CONTRACTS = Object.freeze({
  synthesizer: Object.freeze({
    role: "preference-state-synthesizer",
    schemaName: "memory-preference-state-synthesis-v1",
    promptVersion: "preference-state-synthesis-v1",
    promptFile: "preference-state-synthesizer-system-prompt.md",
    schema: PREFERENCE_STATE_SYNTHESIS_SCHEMA,
  }),
  critic: Object.freeze({
    role: "preference-state-critic",
    schemaName: "memory-preference-state-critic-v1",
    promptVersion: "preference-state-critic-v1",
    promptFile: "preference-state-critic-system-prompt.md",
    schema: PREFERENCE_STATE_CRITIC_SCHEMA,
  }),
});

function enumValue(value, field, allowed) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) {
    throw new Error(`${field} has an unknown value: ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function parseObject(value, label) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error(`${label} returned empty output.`);
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${label} did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} output must be an object.`);
  }
  return parsed;
}

export function parsePreferenceStateSynthesis(value) {
  const parsed = parseObject(value, "Preference state synthesizer");
  const scope = parsed.scope;
  const decisions = Array.isArray(parsed.evidenceDecisions) ? parsed.evidenceDecisions : null;
  const confidence = Number(parsed.confidence);
  const rationale = clean(parsed.rationale);
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || !decisions
    || decisions.length > 500 || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error("Preference state synthesis has an invalid envelope.");
  }
  return {
    action: enumValue(parsed.action, "action", ACTIONS),
    proposedLevel: enumValue(parsed.proposedLevel, "proposedLevel", LEVELS),
    scopeChange: enumValue(parsed.scopeChange, "scopeChange", ["none", "narrow", "replace", "unknown"]),
    scope: {
      kind: clean(scope.kind),
      label: clean(scope.label),
      context: clean(scope.context),
    },
    evidenceDecisions: decisions.map((item, index) => {
      const observationId = clean(item?.observationId);
      const decisionRationale = clean(item?.rationale);
      if (!observationId || !decisionRationale) {
        throw new Error(`evidenceDecisions[${index}] is incomplete.`);
      }
      return {
        observationId,
        treatment: enumValue(
          item.treatment,
          `evidenceDecisions[${index}].treatment`,
          TREATMENTS,
        ),
        rationale: decisionRationale,
      };
    }),
    confidence,
    rationale,
  };
}

export function parsePreferenceStateCritic(value) {
  const parsed = parseObject(value, "Preference state critic");
  const issues = Array.isArray(parsed.issues) ? parsed.issues : null;
  const summary = clean(parsed.summary);
  if (!issues || issues.length > 100 || !summary) {
    throw new Error("Preference state critic has an invalid envelope.");
  }
  return {
    verdict: enumValue(parsed.verdict, "verdict", ["approve_shadow", "revise", "human_review"]),
    issues: issues.map((item, index) => {
      const observationIds = [...new Set(
        (Array.isArray(item?.observationIds) ? item.observationIds : []).map(clean).filter(Boolean),
      )];
      const rationale = clean(item?.rationale);
      if (!rationale) throw new Error(`issues[${index}] requires rationale.`);
      return {
        code: enumValue(item.code, `issues[${index}].code`, [
          "subject_mismatch", "temporal_error", "scope_overreach",
          "constraint_ignored", "counterevidence_omitted", "duplicate_evidence",
          "unsupported_transition", "unsupported_claim", "insufficient_evidence",
          "unresolved_conflict", "other",
        ]),
        severity: enumValue(item.severity, `issues[${index}].severity`, ["critical", "warning"]),
        observationIds,
        rationale,
      };
    }),
    summary,
  };
}

export function buildPreferenceStateSynthesisInput(snapshot) {
  return [
    "对代码整理出的完整同键证据提出一个影子状态方案。不得读取数据库或创建正式记忆。",
    "evidenceDecisions 必须逐条且仅覆盖 snapshot.requiredDecisionObservationIds。",
    "只能从 snapshot.allowedLevels 选择 proposedLevel；不能改变主体、canonicalKey、策略或确定性统计。",
    "只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

export function buildPreferenceStateCriticInput(snapshot, synthesis) {
  return [
    "独立审查结构化偏好状态方案。你看不到综合器的隐藏推理，只能依据证据快照、代码统计和最终方案找问题。",
    "不得改写方案或创建正式记忆；无法排除风险时选择 human_review。",
    "只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify({ snapshot, synthesis }, null, 2),
  ].join("\n");
}
