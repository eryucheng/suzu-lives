import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createExternalCapabilitiesIpcService,
  registerExternalCapabilitiesIpc,
} from "../electron/ipc/external-capabilities-ipc.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-external-ipc-"));
}

async function externalManifest(root) {
  const packageRoot = path.join(root, "sample-capability");
  await fs.mkdir(path.join(packageRoot, "skill"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "skill", "SKILL.md"), "# Sample external ability\n", "utf8");
  const manifestPath = path.join(packageRoot, "suzu-capability.json");
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    id: "sample.external",
    name: "示例外部能力",
    version: "1.0.0",
    description: "A local test Skill plus MCP.",
    adapters: {
      skill: { directory: "skill" },
      mcp: {
        transport: "http",
        url: "https://mcp.example.test/stream",
        headers: { Authorization: "Bearer \${MCP_TEST_TOKEN}" },
      },
    },
  }, null, 2)}\n`, "utf8");
  return manifestPath;
}

test("Agent Core external capability IPC imports a manifest and installs global Skill/MCP registrations", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const manifestPath = await externalManifest(root);
  const handlers = new Map();
  const pickerCalls = [];
  let reloads = 0;
  const settingsService = {
    load: () => ({ dataRoot }),
    response: () => ({ dataRoot }),
  };
  const service = createExternalCapabilitiesIpcService({
    runtime: () => ({ reloadExternalCapabilities: async () => { reloads += 1; return { reloaded: true }; } }),
    settingsService,
  });
  registerExternalCapabilitiesIpc({
    externalCapabilitiesService: service,
    getMainWindow: () => null,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {
      showOpenDialog: async (_window, options) => {
        pickerCalls.push(options);
        return { canceled: false, filePaths: [manifestPath] };
      },
    },
  });

  assert.equal(typeof handlers.get("external-capabilities:snapshot"), "function");
  const imported = await handlers.get("external-capabilities:import")();
  assert.equal(imported.ok, true);
  assert.equal(imported.value.canceled, false);
  assert.equal(imported.value.capability.id, "sample.external");
  assert.deepEqual(pickerCalls[0].properties, ["openFile"]);
  assert.equal(pickerCalls[0].filters[0].extensions[0], "json");

  const enabled = await handlers.get("external-capabilities:set-enabled")(null, { id: "sample.external", enabled: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.value.enabled, true);
  assert.equal(reloads, 1);
  const runtimeHome = path.join(dataRoot, "agent-runtime", "core");
  assert.equal(await fs.readFile(path.join(runtimeHome, "skills", "suzu-external-sample.external", "SKILL.md"), "utf8"), "# Sample external ability\n");
  const patch = await fs.readFile(path.join(runtimeHome, "suzu-external-capabilities.cordis.patch.yml"), "utf8");
  assert.match(patch, /@suzu-lives\/suzu-agent-runtime\/core\/mcp-client/u);
  assert.match(patch, /"Authorization": "Bearer \$\{MCP_TEST_TOKEN\}"/u);
  await assert.rejects(fs.stat(path.join(runtimeHome, ".mcp.json")), { code: "ENOENT" });

  const snapshot = await handlers.get("external-capabilities:snapshot")();
  assert.equal(snapshot.runtime, "agent-core");
  assert.equal(snapshot.scope, "global-agent-core");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.capabilities[0].enabled, true);

  const disabled = await handlers.get("external-capabilities:set-enabled")(null, { id: "sample.external", enabled: false });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.value.enabled, false);
  assert.equal(reloads, 2);
  await assert.rejects(fs.stat(path.join(runtimeHome, "skills", "suzu-external-sample.external", "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(runtimeHome, "suzu-external-capabilities.cordis.patch.yml"), "utf8"), "# Suzu-managed Agent Core external MCP capabilities. Do not edit by hand.\n[]\n");
});
