function clean(value) {
  return String(value ?? "").trim();
}

function unit(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${label} 必须是 0 到 1 之间的数字。`);
  }
  return number;
}

function versionList(value, label) {
  const values = [...new Set((Array.isArray(value) ? value : [])
    .map(clean)
    .filter(Boolean))];
  if (!values.length) throw new Error(`${label} 必须明确列出至少一个允许的策略版本。`);
  return Object.freeze(values);
}

function normalizedDelta(value, neutralValue) {
  if (value === neutralValue) return 0;
  if (value > neutralValue) {
    return (value - neutralValue) / Math.max(Number.EPSILON, 1 - neutralValue);
  }
  return (value - neutralValue) / Math.max(Number.EPSILON, neutralValue);
}

export function normalizeAppliedPlasticityOptions(value) {
  if (!value || value.enabled !== true) {
    return Object.freeze({ enabled: false, configurationVersion: "" });
  }
  const configurationVersion = clean(value.configurationVersion);
  if (!configurationVersion) {
    throw new Error("可塑性排序需要明确的 configurationVersion。");
  }
  const memory = value.memory && typeof value.memory === "object" ? value.memory : null;
  const edge = value.edge && typeof value.edge === "object" ? value.edge : null;
  if (!memory || !edge) {
    throw new Error("可塑性排序必须同时提供 memory 与 edge 配置。");
  }
  return Object.freeze({
    enabled: true,
    configurationVersion,
    memory: Object.freeze({
      neutralValue: unit(memory.neutralValue, "memory.neutralValue"),
      maximumScoreAdjustment: unit(
        memory.maximumScoreAdjustment,
        "memory.maximumScoreAdjustment",
      ),
      allowedPolicyVersions: versionList(
        memory.allowedPolicyVersions,
        "memory.allowedPolicyVersions",
      ),
    }),
    edge: Object.freeze({
      neutralValue: unit(edge.neutralValue, "edge.neutralValue"),
      maximumMultiplierAdjustment: unit(
        edge.maximumMultiplierAdjustment,
        "edge.maximumMultiplierAdjustment",
      ),
      allowedPolicyVersions: versionList(
        edge.allowedPolicyVersions,
        "edge.allowedPolicyVersions",
      ),
    }),
  });
}

export function memoryAccessibilityAdjustment(state, policy) {
  if (!policy?.enabled || !state) return null;
  if (!clean(state.last_applied_at) || !clean(state.last_observation_window_id)) return null;
  if (!policy.memory.allowedPolicyVersions.includes(clean(state.policy_version))) return null;
  const value = unit(state.value, "memory accessibility value");
  const scoreAdjustment = normalizedDelta(value, policy.memory.neutralValue)
    * policy.memory.maximumScoreAdjustment;
  return Object.freeze({
    value,
    policyVersion: clean(state.policy_version),
    configurationVersion: policy.configurationVersion,
    neutralValue: policy.memory.neutralValue,
    scoreAdjustment,
  });
}

export function edgeRelationUtilityAdjustment(state, policy) {
  if (!policy?.enabled || !state) return null;
  if (!clean(state.last_applied_at) || !clean(state.last_observation_window_id)) return null;
  if (!policy.edge.allowedPolicyVersions.includes(clean(state.policy_version))) return null;
  const value = unit(state.value, "edge relation utility value");
  const multiplier = 1 + normalizedDelta(value, policy.edge.neutralValue)
    * policy.edge.maximumMultiplierAdjustment;
  return Object.freeze({
    value,
    policyVersion: clean(state.policy_version),
    configurationVersion: policy.configurationVersion,
    neutralValue: policy.edge.neutralValue,
    multiplier: Math.max(0, multiplier),
  });
}

export function appliedPlasticityAudit(policy) {
  if (!policy?.enabled) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    configurationVersion: policy.configurationVersion,
    memoryPolicyVersions: [...policy.memory.allowedPolicyVersions],
    edgePolicyVersions: [...policy.edge.allowedPolicyVersions],
    memoryNeutralValue: policy.memory.neutralValue,
    maximumMemoryScoreAdjustment: policy.memory.maximumScoreAdjustment,
    edgeNeutralValue: policy.edge.neutralValue,
    maximumEdgeMultiplierAdjustment: policy.edge.maximumMultiplierAdjustment,
  });
}
