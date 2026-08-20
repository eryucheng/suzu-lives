import {
  SUZU_AGENT_CONTEXT_LAYER_KINDS,
  createSuzuAgentDefinition,
} from "@suzu-lives/suzu-agent-core";

export const SUZU_COMPANION_AGENT_PRESET = "suzu-companion";

const PROFILE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9._-]*$/u;
const PRESET_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const DEFAULT_COMPANION_COMPONENT_ROLES = Object.freeze([
  "direct-terminal",
  "filesystem",
  "background-jobs",
]);

/**
 * The list deliberately describes the complete static Agent Core composition, not
 * just tools.  The installed preset asset is the executable source of this
 * mapping; this declaration is the product-owned contract that chooses it.
 */
export const SUZU_COMPANION_PROFILE_BINDING = Object.freeze({
  profileId: "companion",
  agentPreset: SUZU_COMPANION_AGENT_PRESET,
  componentRoles: DEFAULT_COMPANION_COMPONENT_ROLES,
  contextLayerKinds: SUZU_AGENT_CONTEXT_LAYER_KINDS,
  // Product-level composition deliberately uses Suzu capability names rather
  // than upstream package specifiers. The preset asset maps these roles to
  // the private, vendored implementation when a session starts.
  executionComponents: Object.freeze([
    "persona",
    "instruction-loader",
    "lifecycle-hooks",
    "capability-bridge",
    "structured-generation",
    "conversation-compaction",
    "direct-terminal",
    "filesystem",
    "filesystem-search",
    "background-jobs",
  ]),
});

export const SUZU_DEFAULT_PROFILE_BINDINGS = Object.freeze([
  SUZU_COMPANION_PROFILE_BINDING,
]);

export class SuzuAgentCompositionError extends Error {
  constructor(code, message, { details } = {}) {
    super(message);
    this.name = "SuzuAgentCompositionError";
    this.code = code;
    this.details = Object.freeze({ ...(details && typeof details === "object" ? details : {}) });
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedList(value, label, { identifierPattern = null } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SuzuAgentCompositionError("INVALID_BINDING_LIST", `${label}必须是非空字符串数组。`);
  }
  const result = value.map((item) => clean(item));
  if (result.some((item) => !item)) {
    throw new SuzuAgentCompositionError("INVALID_BINDING_LIST", `${label}不能包含空值。`, { details: { value: result } });
  }
  if (identifierPattern && result.some((item) => !identifierPattern.test(item))) {
    throw new SuzuAgentCompositionError("INVALID_BINDING_IDENTIFIER", `${label}包含无效标识。`, { details: { value: result } });
  }
  if (new Set(result).size !== result.length) {
    throw new SuzuAgentCompositionError("DUPLICATE_BINDING_VALUE", `${label}不能重复。`, { details: { value: result } });
  }
  return Object.freeze(result);
}

function normalizeBinding(value, index) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const profileId = clean(source.profileId);
  const agentPreset = clean(source.agentPreset);
  if (!PROFILE_IDENTIFIER_PATTERN.test(profileId)) {
    throw new SuzuAgentCompositionError("INVALID_PROFILE_BINDING", "Agent profile 绑定必须声明有效 profile 标识。", {
      details: { index, profileId },
    });
  }
  if (!PRESET_IDENTIFIER_PATTERN.test(agentPreset)) {
    throw new SuzuAgentCompositionError("INVALID_PRESET_BINDING", "Agent profile 绑定必须声明有效 preset 标识。", {
      details: { index, agentPreset },
    });
  }
  return Object.freeze({
    profileId,
    agentPreset,
    componentRoles: normalizedList(source.componentRoles, `${profileId} 的 componentRoles`, { identifierPattern: PROFILE_IDENTIFIER_PATTERN }),
    contextLayerKinds: normalizedList(source.contextLayerKinds, `${profileId} 的 contextLayerKinds`, { identifierPattern: PROFILE_IDENTIFIER_PATTERN }),
    executionComponents: normalizedList(source.executionComponents, `${profileId} 的 executionComponents`),
  });
}

function normalizeBindings(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SuzuAgentCompositionError("INVALID_PROFILE_BINDINGS", "Agent composition 至少需要一个 profile 绑定。 ");
  }
  const bindings = value.map((item, index) => normalizeBinding(item, index));
  const profileIds = bindings.map((binding) => binding.profileId);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new SuzuAgentCompositionError("DUPLICATE_PROFILE_BINDING", "同一 profile 只能映射到一个 Agent preset。", {
      details: { profileIds },
    });
  }
  const bindingsByPreset = new Map();
  for (const binding of bindings) {
    const existing = bindingsByPreset.get(binding.agentPreset);
    if (existing && (!sameSequence(existing.componentRoles, binding.componentRoles)
      || !sameSequence(existing.contextLayerKinds, binding.contextLayerKinds)
      || !sameSequence(existing.executionComponents, binding.executionComponents))) {
      throw new SuzuAgentCompositionError("AMBIGUOUS_PRESET_COMPOSITION", "同一个 Agent preset 不能映射两套不同 composition。", {
        details: { agentPreset: binding.agentPreset, profiles: [existing.profileId, binding.profileId] },
      });
    }
    bindingsByPreset.set(binding.agentPreset, binding);
  }
  return Object.freeze(bindings);
}

/**
 * Maps Suzu's provider-neutral agent definition to its selected Agent Core
 * composition. It does not mount plugins or call the kernel: the product runtime
 * remains responsible for installing the product-owned preset asset.
 */
export function createSuzuAgentComposition({
  definition = createSuzuAgentDefinition(),
  profileBindings = SUZU_DEFAULT_PROFILE_BINDINGS,
} = {}) {
  if (!definition || typeof definition.resolve !== "function" || !clean(definition.defaultProfileId)) {
    throw new SuzuAgentCompositionError("INVALID_AGENT_DEFINITION", "Suzu Agent Definition 缺少可解析的默认 profile。 ");
  }
  const bindings = normalizeBindings(profileBindings);
  const bindingsByProfile = new Map(bindings.map((binding) => [binding.profileId, binding]));

  const resolve = ({ profileId = definition.defaultProfileId } = {}) => {
    const plan = definition.resolve({ profileId });
    const binding = bindingsByProfile.get(plan.profileId);
    if (!binding) {
      throw new SuzuAgentCompositionError("UNMAPPED_PROFILE", `Suzu profile ${plan.profileId} 尚未映射到 Agent preset。`, {
        details: { profileId: plan.profileId, availableProfiles: bindings.map((item) => item.profileId) },
      });
    }
    const planLayerKinds = plan.contextLayers.map((layer) => layer.kind);
    if (!sameSequence(plan.componentRoles, binding.componentRoles)) {
      throw new SuzuAgentCompositionError("COMPONENT_ROLE_MISMATCH", `profile ${plan.profileId} 的组件角色与 Agent preset 映射不一致。`, {
        details: { profileId: plan.profileId, plan: plan.componentRoles, binding: binding.componentRoles },
      });
    }
    if (!sameSequence(planLayerKinds, binding.contextLayerKinds)) {
      throw new SuzuAgentCompositionError("CONTEXT_LAYER_MISMATCH", `profile ${plan.profileId} 的上下文层与 Agent preset 映射不一致。`, {
        details: { profileId: plan.profileId, plan: planLayerKinds, binding: binding.contextLayerKinds },
      });
    }
    return Object.freeze({
      agentKey: plan.agentKey,
      profileId: plan.profileId,
      agentPreset: binding.agentPreset,
      componentRoles: plan.componentRoles,
      contextLayers: plan.contextLayers,
      executionComponents: binding.executionComponents,
      compositionIsStaticForSession: true,
    });
  };

  const transition = ({ fromProfileId, toProfileId } = {}) => {
    const from = resolve({ profileId: fromProfileId });
    const to = resolve({ profileId: toProfileId });
    const sameRuntimeComposition = from.agentPreset === to.agentPreset;
    return Object.freeze({
      agentKey: to.agentKey,
      fromProfileId: from.profileId,
      toProfileId: to.profileId,
      fromAgentPreset: from.agentPreset,
      toAgentPreset: to.agentPreset,
      sameRuntimeComposition,
      requiresNewAgentSession: !sameRuntimeComposition,
    });
  };

  return Object.freeze({
    definition,
    profileBindings: bindings,
    resolve,
    transition,
  });
}
