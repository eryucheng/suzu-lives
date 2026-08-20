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
import { resolveAgentSessionStoragePaths } from "../electron/services/agent-session-storage.mjs";

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

test("moving the data root keeps its managed contacts and DSH history bound to the new root", () => {
  const appData = temporaryDirectory("suzu-storage-contacts-app-");
  const localAppData = temporaryDirectory("suzu-storage-contacts-local-");
  const legacyUserDataPath = temporaryDirectory("suzu-storage-contacts-legacy-");
  const first = createDataStorageLocationService({ appData, localAppData, legacyUserDataPath, configuredRoot: "" });
  const sourceRoot = first.dataRoot;
  const sourceContactsRoot = path.join(sourceRoot, "contacts");
  const sourceProjectRoot = path.join(sourceContactsRoot, "contact-source");
  const sessionId = "session-source";
  fs.mkdirSync(sourceProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "settings.json"), `${JSON.stringify({
    contactsRoot: sourceContactsRoot,
    projectRoot: sourceProjectRoot,
  }, null, 2)}\n`);

  const sourceRuntimeHome = path.join(sourceRoot, "agent-runtime", "core");
  const sourceSession = resolveAgentSessionStoragePaths({
    runtimeHome: sourceRuntimeHome,
    projectRoot: sourceProjectRoot,
    sessionId,
  });
  fs.mkdirSync(sourceSession.sessionDirectory, { recursive: true });
  fs.writeFileSync(path.join(sourceSession.sessionDirectory, "session.jsonl"), `${JSON.stringify({
    type: "session",
    version: 0,
    id: sessionId,
    cwd: sourceProjectRoot,
  })}\n{"type":"event","seq":1}\n`);
  fs.mkdirSync(path.dirname(sourceSession.workspaceFile), { recursive: true });
  fs.writeFileSync(sourceSession.workspaceFile, `${JSON.stringify({
    unit: { name: "workspace", version: 2 },
    global: { initialized: true, workspaceIds: ["source"], archivedSessionIds: [] },
    tables: {
      workspaces: {
        source: { path: sourceProjectRoot, sessionIds: [sessionId] },
      },
    },
  }, null, 2)}\n`);
  const scheduledTaskPath = path.join(sourceRoot, "automation", "schedule", "tasks", "task-source.json");
  fs.mkdirSync(path.dirname(scheduledTaskPath), { recursive: true });
  fs.writeFileSync(scheduledTaskPath, `${JSON.stringify({
    target: { type: "operation", name: "conversation-compactor", projectRoot: sourceProjectRoot },
  }, null, 2)}\n`);

  const destinationParent = temporaryDirectory("suzu-storage-contacts-destination-");
  const targetRoot = dataRootForSelectedDirectory(destinationParent);
  first.scheduleMigration(targetRoot);
  const afterRestart = createDataStorageLocationService({ appData, localAppData, legacyUserDataPath, configuredRoot: "" });
  const targetContactsRoot = path.join(targetRoot, "contacts");
  const targetProjectRoot = path.join(targetContactsRoot, "contact-source");
  const copiedOldSession = resolveAgentSessionStoragePaths({
    runtimeHome: path.join(targetRoot, "agent-runtime", "core"),
    projectRoot: sourceProjectRoot,
    sessionId,
  });
  const targetSession = resolveAgentSessionStoragePaths({
    runtimeHome: path.join(targetRoot, "agent-runtime", "core"),
    projectRoot: targetProjectRoot,
    sessionId,
  });

  assert.equal(afterRestart.dataRoot, targetRoot);
  const migratedSettings = JSON.parse(fs.readFileSync(path.join(targetRoot, "settings.json"), "utf8"));
  assert.equal(migratedSettings.contactsRoot, targetContactsRoot);
  assert.equal(migratedSettings.projectRoot, targetProjectRoot);
  assert.equal(fs.existsSync(sourceSession.sessionDirectory), true);
  assert.equal(fs.existsSync(copiedOldSession.sessionDirectory), false);
  assert.equal(fs.existsSync(targetSession.sessionDirectory), true);
  const header = JSON.parse(fs.readFileSync(path.join(targetSession.sessionDirectory, "session.jsonl"), "utf8").split("\n")[0]);
  assert.equal(header.cwd, targetProjectRoot);
  const workspace = JSON.parse(fs.readFileSync(targetSession.workspaceFile, "utf8"));
  assert.equal(workspace.tables.workspaces.source.path, targetProjectRoot);
  const migratedTask = JSON.parse(fs.readFileSync(path.join(targetRoot, "automation", "schedule", "tasks", "task-source.json"), "utf8"));
  assert.equal(migratedTask.target.projectRoot, targetProjectRoot);
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
