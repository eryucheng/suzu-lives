import assert from "node:assert/strict";
import test from "node:test";

import {
  SUZU_AGENT_CONTEXT_LAYER_KINDS,
  SUZU_AGENT_KEY,
  SuzuAgentCoreError,
  createSuzuAgentDefinition,
} from "../src/index.mjs";

test("the default Suzu definition resolves one shared product agent key", () => {
  const definition = createSuzuAgentDefinition();
  const plan = definition.resolve();

  assert.equal(definition.agentKey, SUZU_AGENT_KEY);
  assert.equal(plan.agentKey, "suzu");
  assert.equal("identityScope" in plan, false);
  assert.equal(plan.profileId, "companion");
  assert.deepEqual(plan.componentRoles, ["direct-terminal", "filesystem", "background-jobs"]);
  assert.deepEqual(plan.contextLayers.map((layer) => layer.kind), SUZU_AGENT_CONTEXT_LAYER_KINDS);
  assert.deepEqual(plan.contextLayers.map((layer) => layer.source), [
    "suzu-base-policy",
    "suzu-global",
    "suzu-contact",
    "suzu-nested",
    "profile-companion",
    "suzu-lifecycle",
  ]);
  assert.throws(() => { plan.contextLayers.push({}); }, TypeError);
});

test("profiles share one product agent key without defining a persona", () => {
  const definition = createSuzuAgentDefinition({
    profiles: [
      { id: "companion", componentRoles: ["direct-terminal"] },
      {
        id: "code",
        componentRoles: ["direct-terminal", "filesystem", "goal"],
        contextLayers: [
          { kind: "base-policy", source: "suzu-base-policy" },
          { kind: "global-instructions", source: "suzu-global" },
          { kind: "contact-instructions", source: "suzu-contact" },
          { kind: "profile-directive", source: "profile-code" },
          { kind: "dynamic-context", source: "suzu-lifecycle" },
        ],
      },
    ],
  });

  const companion = definition.resolve({ profileId: "companion" });
  const code = definition.resolve({ profileId: "code" });

  assert.equal(companion.agentKey, code.agentKey);
  assert.deepEqual(code.componentRoles, ["direct-terminal", "filesystem", "goal"]);
  assert.deepEqual(code.contextLayers.map((layer) => layer.kind), [
    "base-policy",
    "global-instructions",
    "contact-instructions",
    "profile-directive",
    "dynamic-context",
  ]);
});

test("the definition rejects invalid or ambiguous composition instead of guessing", () => {
  assert.throws(
    () => createSuzuAgentDefinition({ profiles: [{ id: "Companion" }] }),
    (error) => error instanceof SuzuAgentCoreError && error.code === "INVALID_IDENTIFIER",
  );
  assert.throws(
    () => createSuzuAgentDefinition({ profiles: [{ id: "companion" }, { id: "companion" }] }),
    (error) => error instanceof SuzuAgentCoreError && error.code === "DUPLICATE_PROFILE",
  );
  assert.throws(
    () => createSuzuAgentDefinition({ defaultProfileId: "code" }),
    (error) => error instanceof SuzuAgentCoreError && error.code === "DEFAULT_PROFILE_MISSING",
  );
  const definition = createSuzuAgentDefinition();
  assert.throws(
    () => definition.resolve({ profileId: "game" }),
    (error) => error instanceof SuzuAgentCoreError && error.code === "PROFILE_NOT_FOUND",
  );
});
