import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  AgentExternalCapabilityRegistrationError,
  SUZU_AGENT_EXTERNAL_CAPABILITIES_PATCH_FILENAME,
  createAgentExternalCapabilityRegistration,
  ensureSuzuAgentExternalCapabilitiesPatch,
} from "../electron/services/agent-external-capabilities.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-agent-external-capabilities-"));
}

function registrationInput() {
  return {
    capabilityId: "sample-tools",
    version: "1.2.3",
    skill: {
      files: [
        { relativePath: "SKILL.md", content: "# Sample tools\n\nUse the supplied MCP tool.\n" },
        { relativePath: "references/notes.md", content: "A local supporting file.\n" },
      ],
    },
    mcp: {
      configuration: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: { SAMPLE_TOKEN: "${SAMPLE_TOKEN}" },
      },
    },
  };
}

test("Agent external registration materializes an owned Skill and a native MCP patch", async () => {
  const root = await temporaryRoot();
  const runtimeHome = path.join(root, "data", "agent-runtime", "core");
  let reloads = 0;
  const adapter = createAgentExternalCapabilityRegistration({
    runtimeHome,
    onChanged: async () => { reloads += 1; },
  });

  const written = await adapter.write(registrationInput());
  assert.equal(written.registration.skill.registered, true);
  assert.equal(written.registration.mcp.registered, true);
  assert.equal(reloads, 1);

  const skillDirectory = path.join(runtimeHome, "skills", "suzu-external-sample-tools");
  assert.equal(await fs.readFile(path.join(skillDirectory, "SKILL.md"), "utf8"), "# Sample tools\n\nUse the supplied MCP tool.\n");
  assert.equal(await fs.readFile(path.join(skillDirectory, "references", "notes.md"), "utf8"), "A local supporting file.\n");
  const metadata = JSON.parse(await fs.readFile(path.join(skillDirectory, ".suzu-lives-external-capability.json"), "utf8"));
  assert.equal(metadata.capabilityId, "sample-tools");
  assert.equal(metadata.version, "1.2.3");

  const patchPath = path.join(runtimeHome, SUZU_AGENT_EXTERNAL_CAPABILITIES_PATCH_FILENAME);
  const patch = await fs.readFile(patchPath, "utf8");
  assert.match(patch, /@suzu-lives\/suzu-agent-runtime\/core\/mcp-client/u);
  assert.match(patch, /serverName: "suzu_/u);
  assert.match(patch, /transport: stdio/u);
  assert.match(patch, /SAMPLE_TOKEN: !!js process\.env\.SAMPLE_TOKEN/u);
  await assert.rejects(fs.stat(path.join(runtimeHome, ".mcp.json")), { code: "ENOENT" });

  const inspected = await adapter.inspect({ capabilityId: "sample-tools", types: ["skill", "mcp"] });
  assert.equal(inspected.registered, true);
  assert.equal(inspected.skill.version, "1.2.3");
  assert.equal(inspected.mcp.version, "1.2.3");

  const removed = await adapter.remove({ capabilityId: "sample-tools", types: ["skill", "mcp"] });
  assert.equal(removed.removed, true);
  assert.equal(reloads, 2);
  await assert.rejects(fs.stat(path.join(skillDirectory, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(patchPath, "utf8"), "# Suzu-managed Agent Core external MCP capabilities. Do not edit by hand.\n[]\n");
  const inspectedAfter = await adapter.inspect({ capabilityId: "sample-tools", types: ["skill", "mcp"] });
  assert.equal(inspectedAfter.registered, false);
});

test("Agent external registration refuses to overwrite a manually changed managed MCP patch", async () => {
  const root = await temporaryRoot();
  const runtimeHome = path.join(root, "data", "agent-runtime", "core");
  const adapter = createAgentExternalCapabilityRegistration({ runtimeHome });
  await adapter.write(registrationInput());
  const patchPath = path.join(runtimeHome, SUZU_AGENT_EXTERNAL_CAPABILITIES_PATCH_FILENAME);
  await fs.writeFile(patchPath, "# changed by user\n", "utf8");

  await assert.rejects(
    adapter.remove({ capabilityId: "sample-tools", types: ["skill", "mcp"] }),
    (error) => error instanceof AgentExternalCapabilityRegistrationError && error.code === "AGENT_EXTERNAL_PATCH_MODIFIED",
  );
  await assert.doesNotReject(fs.stat(path.join(runtimeHome, "skills", "suzu-external-sample-tools", "SKILL.md")));
  assert.equal(await fs.readFile(patchPath, "utf8"), "# changed by user\n");
});

test("Agent external patch initialization creates the empty managed overlay without starting a process", async () => {
  const root = await temporaryRoot();
  const runtimeHome = path.join(root, "data", "agent-runtime", "core");
  const result = await ensureSuzuAgentExternalCapabilitiesPatch({ runtimeHome });
  assert.equal(result.patchFile, path.join(runtimeHome, SUZU_AGENT_EXTERNAL_CAPABILITIES_PATCH_FILENAME));
  assert.equal(await fs.readFile(result.patchFile, "utf8"), "# Suzu-managed Agent Core external MCP capabilities. Do not edit by hand.\n[]\n");
});
