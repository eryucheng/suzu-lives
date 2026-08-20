// A product-internal stable key.  It is never sent to the model as a name or
// persona; user-managed SUZU.md owns those human-facing facts.
export const SUZU_AGENT_KEY = "suzu";
export const SUZU_DEFAULT_PROFILE_ID = "companion";

export const SUZU_AGENT_CONTEXT_LAYER_KINDS = Object.freeze([
  "base-policy",
  "global-instructions",
  "contact-instructions",
  "nested-instructions",
  "profile-directive",
  "dynamic-context",
]);

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9._-]*$/u;
const CONTEXT_LAYER_KINDS = new Set(SUZU_AGENT_CONTEXT_LAYER_KINDS);

export class SuzuAgentCoreError extends Error {
  constructor(code, message, { details } = {}) {
    super(message);
    this.name = "SuzuAgentCoreError";
    this.code = code;
    this.details = Object.freeze({ ...(details && typeof details === "object" ? details : {}) });
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function identifier(value, label) {
  const normalized = clean(value);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new SuzuAgentCoreError("INVALID_IDENTIFIER", `${label}必须是小写 Agent 标识。`, { details: { value: normalized } });
  }
  return normalized;
}

function uniqueIdentifiers(value, label) {
  if (!Array.isArray(value)) {
    throw new SuzuAgentCoreError("INVALID_IDENTIFIER_LIST", `${label}必须是标识数组。`);
  }
  const normalized = value.map((item) => identifier(item, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new SuzuAgentCoreError("DUPLICATE_IDENTIFIER", `${label}不能重复。`, { details: { values: normalized } });
  }
  return Object.freeze(normalized);
}

function contextLayers(value, profileId, basePolicyId) {
  const source = value === undefined ? [
    { kind: "base-policy", source: basePolicyId },
    { kind: "global-instructions", source: "suzu-global" },
    { kind: "contact-instructions", source: "suzu-contact" },
    { kind: "nested-instructions", source: "suzu-nested" },
    { kind: "profile-directive", source: `profile-${profileId}` },
    { kind: "dynamic-context", source: "suzu-lifecycle" },
  ] : value;
  if (!Array.isArray(source) || source.length === 0) {
    throw new SuzuAgentCoreError("INVALID_CONTEXT_LAYERS", "profile 必须声明非空上下文层。", { details: { profileId } });
  }
  const layers = source.map((item, index) => {
    const candidate = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const kind = clean(candidate.kind);
    if (!CONTEXT_LAYER_KINDS.has(kind)) {
      throw new SuzuAgentCoreError("UNKNOWN_CONTEXT_LAYER", `未知的上下文层：${kind || "(空)"}。`, {
        details: { profileId, index, kind },
      });
    }
    const layerSource = identifier(candidate.source, `${kind} 来源`);
    return Object.freeze({ kind, source: layerSource });
  });
  return Object.freeze(layers);
}

function normalizeProfile(value, basePolicyId) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const id = identifier(source.id, "profile 标识");
  const componentRoles = uniqueIdentifiers(source.componentRoles ?? [], `${id} profile 组件角色`);
  return Object.freeze({
    id,
    componentRoles,
    contextLayers: contextLayers(source.contextLayers, id, basePolicyId),
  });
}

function freezePlan({ agentKey, basePolicyId, profile }) {
  return Object.freeze({
    agentKey,
    basePolicyId,
    profileId: profile.id,
    componentRoles: profile.componentRoles,
    contextLayers: profile.contextLayers,
  });
}

/**
 * Declares Suzu's provider-neutral agent-plane composition.  It deliberately
 * does not invoke a model, execute a tool, or refer to execution-kernel internals.
 * A provider adapter later maps its component roles and context layer slots to
 * that provider's documented extension points.
 */
export function createSuzuAgentDefinition({
  agentKey = SUZU_AGENT_KEY,
  basePolicyId = "suzu-base-policy",
  defaultProfileId = SUZU_DEFAULT_PROFILE_ID,
  profiles = [{
    id: SUZU_DEFAULT_PROFILE_ID,
    // The companion owns the basic ability to act on its local machine.
    // Product-specific abilities are installed separately, but a companion
    // without a terminal or filesystem cannot perform ordinary requests such
    // as creating a folder.
    componentRoles: ["direct-terminal", "filesystem", "background-jobs"],
  }],
} = {}) {
  const normalizedAgentKey = identifier(agentKey, "Agent 内部键");
  const normalizedBasePolicyId = identifier(basePolicyId, "基础 policy 标识");
  const normalizedDefaultProfileId = identifier(defaultProfileId, "默认 profile 标识");
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new SuzuAgentCoreError("INVALID_PROFILES", "Suzu Agent 至少需要一个 profile。 ");
  }
  const normalizedProfiles = profiles.map((profile) => normalizeProfile(profile, normalizedBasePolicyId));
  const profileIds = normalizedProfiles.map((profile) => profile.id);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new SuzuAgentCoreError("DUPLICATE_PROFILE", "Suzu Agent profile 标识不能重复。", { details: { profileIds } });
  }
  const profilesById = new Map(normalizedProfiles.map((profile) => [profile.id, profile]));
  if (!profilesById.has(normalizedDefaultProfileId)) {
    throw new SuzuAgentCoreError("DEFAULT_PROFILE_MISSING", "默认 profile 必须存在于 Agent 定义中。", {
      details: { defaultProfileId: normalizedDefaultProfileId },
    });
  }

  const resolve = ({ profileId = normalizedDefaultProfileId } = {}) => {
    const selectedProfileId = identifier(profileId, "profile 标识");
    const profile = profilesById.get(selectedProfileId);
    if (!profile) {
      throw new SuzuAgentCoreError("PROFILE_NOT_FOUND", `Suzu Agent 没有 profile：${selectedProfileId}。`, {
        details: { profileId: selectedProfileId, availableProfiles: profileIds },
      });
    }
    return freezePlan({
      agentKey: normalizedAgentKey,
      basePolicyId: normalizedBasePolicyId,
      profile,
    });
  };

  return Object.freeze({
    agentKey: normalizedAgentKey,
    basePolicyId: normalizedBasePolicyId,
    defaultProfileId: normalizedDefaultProfileId,
    profiles: Object.freeze([...normalizedProfiles]),
    resolve,
  });
}
