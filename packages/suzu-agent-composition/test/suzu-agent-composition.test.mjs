import assert from "node:assert/strict";
import test from "node:test";

import {
  SUZU_COMPANION_AGENT_PRESET,
  SUZU_COMPANION_PROFILE_BINDING,
  SuzuAgentCompositionError,
  createSuzuAgentComposition,
} from "../src/index.mjs";
import { createSuzuAgentDefinition } from "@suzu-lives/suzu-agent-core";

test("the companion definition maps to Suzu's product-owned Agent preset", () => {
  const adapter = createSuzuAgentComposition();
  const binding = adapter.resolve();

  assert.equal(binding.agentKey, "suzu");
  assert.equal("identityScope" in binding, false);
  assert.equal(binding.profileId, "companion");
  assert.equal(binding.agentPreset, SUZU_COMPANION_AGENT_PRESET);
  assert.equal(binding.compositionIsStaticForSession, true);
  assert.deepEqual(binding.componentRoles, ["direct-terminal", "filesystem", "background-jobs"]);
  assert.deepEqual(binding.executionComponents, SUZU_COMPANION_PROFILE_BINDING.executionComponents);
});

test("a profile with a different Agent composition keeps its product agent key but requires a new session", () => {
  const definition = createSuzuAgentDefinition({
    profiles: [
      { id: "companion", componentRoles: ["direct-terminal", "filesystem", "background-jobs"] },
      { id: "code", componentRoles: ["direct-terminal", "filesystem", "background-jobs", "goal"] },
    ],
  });
  const adapter = createSuzuAgentComposition({
    definition,
    profileBindings: [
      SUZU_COMPANION_PROFILE_BINDING,
      {
        profileId: "code",
        agentPreset: "suzu-code",
        componentRoles: ["direct-terminal", "filesystem", "background-jobs", "goal"],
        contextLayerKinds: [
          "base-policy",
          "global-instructions",
          "contact-instructions",
          "nested-instructions",
          "profile-directive",
          "dynamic-context",
        ],
        executionComponents: ["persona", "goal-management"],
      },
    ],
  });

  const transition = adapter.transition({ fromProfileId: "companion", toProfileId: "code" });
  assert.equal(transition.agentKey, "suzu");
  assert.equal(transition.sameRuntimeComposition, false);
  assert.equal(transition.requiresNewAgentSession, true);
  assert.equal(transition.toAgentPreset, "suzu-code");
});

test("the adapter rejects unmapped or composition-mismatched profiles instead of guessing a preset", () => {
  const definition = createSuzuAgentDefinition({
    profiles: [
      { id: "companion", componentRoles: ["direct-terminal", "filesystem", "background-jobs"] },
      { id: "code", componentRoles: ["direct-terminal"] },
    ],
  });
  const adapter = createSuzuAgentComposition({ definition });
  assert.throws(
    () => adapter.resolve({ profileId: "code" }),
    (error) => error instanceof SuzuAgentCompositionError && error.code === "UNMAPPED_PROFILE",
  );

  const mismatch = createSuzuAgentComposition({
    definition: createSuzuAgentDefinition({ profiles: [{ id: "companion", componentRoles: ["direct-terminal"] }] }),
  });
  assert.throws(
    () => mismatch.resolve(),
    (error) => error instanceof SuzuAgentCompositionError && error.code === "COMPONENT_ROLE_MISMATCH",
  );
});
