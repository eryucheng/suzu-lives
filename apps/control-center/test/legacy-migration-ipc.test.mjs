import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { registerLegacyMigrationIpc } from "../electron/ipc/legacy-migration-ipc.mjs";

const TEST_ROOT = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp\\suzu-lives-migrator-tests";

async function temporaryDirectory(prefix) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TEST_ROOT, prefix));
}

test("legacy migration IPC accepts only the isolated migration window", async () => {
  const dataRoot = await temporaryDirectory("ipc-");
  const handlers = new Map();
  const migrationWindow = { webContents: { id: 1 } };
  let quitCalls = 0;
  registerLegacyMigrationIpc({
    app: { quit: () => { quitCalls += 1; } },
    dataStorageService: { dataRoot },
    getMigrationWindow: () => migrationWindow,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    settingsService: {
      load: () => ({ contactsRoot: "" }),
      save: (value) => value,
      response: () => ({ dataRoot }),
    },
  });

  const inspect = handlers.get("legacy-migration:inspect");
  assert.equal(typeof inspect, "function");
  const rejected = await inspect({ sender: { id: 2 } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "UNAUTHORIZED");

  const accepted = await inspect({ sender: migrationWindow.webContents });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.status, "none");

  const close = handlers.get("legacy-migration:close");
  assert.equal(close({ sender: { id: 2 } }), false);
  assert.equal(close({ sender: migrationWindow.webContents }), true);
  assert.equal(quitCalls, 1);
});
