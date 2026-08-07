import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createExternalCapabilitiesIpcService,
  registerExternalCapabilitiesIpc,
} from "../electron/ipc/external-capabilities-ipc.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-external-ipc-"));
  const packageRoot = path.join(root, "capability");
  const projectRoot = path.join(root, "project");
  const dataRoot = path.join(root, "data");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: IPC test\ndescription: Test\n---\n\nTest skill.\n", "utf8");
  const manifestPath = path.join(packageRoot, "suzu-capability.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    id: "ipc.test",
    name: "IPC 测试能力",
    version: "1.0.0",
    adapters: { skill: { file: "SKILL.md" } },
  }, null, 2));
  return { dataRoot, manifestPath, projectRoot };
}

test("external capability IPC opens a local manifest picker and exposes import and registration controls", async () => {
  const current = await fixture();
  const handlers = new Map();
  const pickerCalls = [];
  const settingsService = {
    load: () => ({ projectRoot: current.projectRoot }),
    response: () => ({ dataRoot: current.dataRoot }),
  };
  const service = createExternalCapabilitiesIpcService({ settingsService });
  registerExternalCapabilitiesIpc({
    externalCapabilitiesService: service,
    getMainWindow: () => null,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {
      showOpenDialog: async (_window, options) => {
        pickerCalls.push(options);
        return { canceled: false, filePaths: [current.manifestPath] };
      },
    },
  });

  assert.equal(typeof handlers.get("external-capabilities:snapshot"), "function");
  const imported = await handlers.get("external-capabilities:import")();
  assert.equal(imported.ok, true);
  assert.equal(imported.value.capability.id, "ipc.test");
  assert.deepEqual(pickerCalls[0].properties, ["openFile"]);
  assert.equal(pickerCalls[0].filters[0].extensions[0], "json");

  const enabled = await handlers.get("external-capabilities:set-enabled")(null, { id: "ipc.test", enabled: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.value.snapshot.capabilities[0].enabled, true);
  assert.match(await fs.readFile(path.join(current.projectRoot, ".claude", "skills", "suzu-external-ipc.test", "SKILL.md"), "utf8"), /IPC test/u);

  const snapshot = await handlers.get("external-capabilities:snapshot")();
  assert.equal(snapshot.capabilities[0].enabled, true);
});
