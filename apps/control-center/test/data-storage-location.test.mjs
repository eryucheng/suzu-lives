import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readSuzuLivesDataRootLocator,
  readSuzuLivesDataRootRedirect,
} from "@suzu-lives/agent-registry";
import {
  createDataStorageLocationService,
  dataRootForSelectedDirectory,
  validateDataRootMigration,
} from "../electron/services/data-storage-location.mjs";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("moves the whole local data root on restart and keeps the old copy as a safe fallback", () => {
  const appData = temporaryDirectory("suzu-storage-app-");
  const localAppData = temporaryDirectory("suzu-storage-local-");
  const legacyUserDataPath = temporaryDirectory("suzu-storage-legacy-");
  fs.writeFileSync(path.join(legacyUserDataPath, "settings.json"), JSON.stringify({ theme: "light", projectRoot: "D:/project" }));

  const first = createDataStorageLocationService({ appData, localAppData, legacyUserDataPath, configuredRoot: "" });
  assert.equal(first.dataRoot, path.join(localAppData, "Suzu Lives"));
  assert.equal(fs.existsSync(path.join(first.dataRoot, "settings.json")), false);
  fs.mkdirSync(path.join(first.dataRoot, "connections"), { recursive: true });
  fs.writeFileSync(path.join(first.dataRoot, "connections", "saved.json"), "stored connection");
  fs.writeFileSync(path.join(first.dataRoot, "SingletonLock"), "transient");

  const destinationParent = temporaryDirectory("suzu-storage-destination-");
  const targetRoot = dataRootForSelectedDirectory(destinationParent);
  assert.deepEqual(first.validateMigration(targetRoot), {
    status: "ready",
    sourceRoot: first.dataRoot,
    targetRoot,
  });
  assert.equal(first.scheduleMigration(targetRoot).status, "scheduled");
  assert.equal(readSuzuLivesDataRootLocator({ appData }).pendingMigration.targetRoot, targetRoot);

  const afterRestart = createDataStorageLocationService({ appData, localAppData, legacyUserDataPath, configuredRoot: "" });
  assert.equal(afterRestart.dataRoot, targetRoot);
  assert.equal(fs.readFileSync(path.join(targetRoot, "connections", "saved.json"), "utf8"), "stored connection");
  assert.equal(fs.existsSync(path.join(targetRoot, "SingletonLock")), false);
  assert.equal(readSuzuLivesDataRootRedirect(first.dataRoot), targetRoot);
  assert.equal(readSuzuLivesDataRootLocator({ appData }).pendingMigration, null);
  assert.equal(afterRestart.snapshot().previousDataRoot, first.dataRoot);
  assert.deepEqual(afterRestart.removePreviousDataCopy(), { status: "removed", previousDataRoot: first.dataRoot });
  assert.equal(fs.existsSync(first.dataRoot), false);
  assert.equal(fs.existsSync(targetRoot), true);
  assert.equal(afterRestart.snapshot().previousDataRoot, "");
});

test("rejects nested locations and existing target folders instead of merging data", () => {
  const sourceRoot = path.join(temporaryDirectory("suzu-storage-source-"), "Suzu Lives");
  fs.mkdirSync(sourceRoot, { recursive: true });
  assert.throws(
    () => validateDataRootMigration({ sourceRoot, targetRoot: path.join(sourceRoot, "nested", "Suzu Lives") }),
    /不能位于当前数据目录内/u,
  );

  const existingTarget = path.join(temporaryDirectory("suzu-storage-existing-"), "Suzu Lives");
  fs.mkdirSync(existingTarget, { recursive: true });
  assert.throws(
    () => validateDataRootMigration({ sourceRoot, targetRoot: existingTarget }),
    /已经有同名/u,
  );
});
