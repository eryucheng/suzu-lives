import { createSuzuAgentLifecycleBridgeTransport } from "./lifecycle-bridge.mjs";

export const name = "suzu-capability-skills";
export const inject = ["skills"];

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const PROVIDER_NAME = "suzu-product-capabilities";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_DESCRIPTION_LENGTH = 600;
const MAX_CONTENT_LENGTH = 64_000;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function timeoutMilliseconds(value) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(candidate)));
}

function sessionIdForScope(scope) {
  return clean(scope?.session?.id || scope?.id);
}

function bounded(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function catalogSkills(value) {
  const source = plainObject(value);
  const seen = new Set();
  return (Array.isArray(source.skills) ? source.skills : []).flatMap((candidate) => {
    const skill = plainObject(candidate);
    const skillName = clean(skill.name);
    const description = bounded(clean(skill.description), MAX_DESCRIPTION_LENGTH);
    if (!SKILL_NAME.test(skillName) || !description || seen.has(skillName)) return [];
    seen.add(skillName);
    return [Object.freeze({ name: skillName, description })];
  });
}

function loadedSkill(value, expectedName) {
  const skill = plainObject(plainObject(value).skill);
  const skillName = clean(skill.name);
  const description = bounded(clean(skill.description), MAX_DESCRIPTION_LENGTH);
  const content = bounded(String(skill.content ?? ""), MAX_CONTENT_LENGTH);
  if (skillName !== expectedName || !SKILL_NAME.test(skillName) || !description || !content) return null;
  return Object.freeze({ name: skillName, description, content });
}

function candidateFor(skill) {
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    invocation: Object.freeze({ modelInvocable: true, userInvocable: false }),
    source: "suzu-product",
    provider: PROVIDER_NAME,
    rank: 300,
    locator: Object.freeze({ name: skill.name }),
  });
}

/**
 * Product actions vary by active contact and configured adapters, so they are
 * exposed through the Core Skill seam instead of copied into a global static
 * skill directory. The Core `skill` tool publishes only each short summary;
 * detailed action contracts are requested from the Electron parent on demand.
 */
export function createSuzuCapabilitySkills({
  transport = createSuzuAgentLifecycleBridgeTransport(),
} = {}) {
  if (typeof transport?.request !== "function") {
    throw new TypeError("capability skills require request().");
  }

  const apply = (ctx, config = {}) => {
    if (typeof ctx?.skills?.registerProvider !== "function") {
      throw new TypeError("capability skills require skills.registerProvider().");
    }
    const timeoutMs = timeoutMilliseconds(plainObject(config).timeoutMs);
    let invalidateCatalog = () => {};
    ctx.skills.registerProvider(({ signal, invalidate }) => {
      invalidateCatalog = invalidate;
      return Object.freeze({
      name: PROVIDER_NAME,
      async list(request = {}) {
        const sessionId = sessionIdForScope(request.scope);
        if (!sessionId) return { candidates: [], complete: true };
        try {
          const response = await transport.request("CapabilitySkillCatalog", { sessionId }, { timeoutMs });
          request.signal?.throwIfAborted?.();
          signal?.throwIfAborted?.();
          const skills = response?.available === true ? catalogSkills(response.result) : [];
          return {
            candidates: skills.map(candidateFor),
            // Capability configuration retires and restarts Suzu's owned Core
            // process. A complete snapshot lets Core publish its normal skill
            // reminder while each action remains revalidated on execution.
            complete: true,
          };
        } catch {
          return { candidates: [], complete: true };
        }
      },
      async get(candidate, request = {}) {
        const expectedName = clean(candidate?.name);
        const sessionId = sessionIdForScope(request.scope);
        if (!SKILL_NAME.test(expectedName) || !sessionId) return undefined;
        try {
          const response = await transport.request("CapabilitySkillRead", {
            sessionId,
            name: expectedName,
          }, { timeoutMs });
          request.signal?.throwIfAborted?.();
          signal?.throwIfAborted?.();
          const skill = response?.available === true ? loadedSkill(response.result, expectedName) : null;
          if (!skill) return undefined;
          return Object.freeze({
            ...skill,
            invocation: Object.freeze({ modelInvocable: true, userInvocable: false }),
            source: "suzu-product",
            provider: PROVIDER_NAME,
          });
        } catch {
          return undefined;
        }
      },
      });
    });
    // A contact can enable or reconfigure a product ability while the same
    // Agent session stays open. Refresh before every model step so its native
    // skill catalog remains truthful; `skill-tool` republishes only when the
    // compact name/description list actually changed.
    if (typeof ctx.on === "function") {
      ctx.on("agent/pre-step", async (_event, next) => {
        invalidateCatalog();
        return next();
      });
    }
  };

  return Object.freeze({ apply });
}

const defaultCapabilitySkills = createSuzuCapabilitySkills();

export function apply(ctx, config = {}) {
  return defaultCapabilitySkills.apply(ctx, config);
}
