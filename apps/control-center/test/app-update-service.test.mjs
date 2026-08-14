import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAppUpdateService } from "../electron/services/app-update.mjs";

function packagedApp(version = "0.1.0") {
  return { isPackaged: true, getVersion: () => version };
}

function packageResources(type) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-update-package-"));
  fs.writeFileSync(path.join(root, "package-type"), type, "utf8");
  return root;
}

class FixtureUpdater extends EventEmitter {
  constructor({ event = "update-available", version = "0.2.0", error = null } = {}) {
    super();
    this.error = error;
    this.event = event;
    this.latestVersion = version;
    this.downloads = 0;
    this.installs = 0;
  }

  async checkForUpdates() {
    if (this.error) throw this.error;
    const info = { version: this.latestVersion };
    this.emit(this.event, info);
    return { updateInfo: info };
  }

  async downloadUpdate() {
    this.downloads += 1;
    return [];
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

test("development and ZIP builds never contact the update source", async () => {
  const developmentUpdater = new FixtureUpdater();
  const development = createAppUpdateService({
    app: { isPackaged: false, getVersion: () => "0.1.0" },
    autoUpdater: developmentUpdater,
  });
  assert.equal((await development.checkForUpdates()).status, "development");
  assert.equal(developmentUpdater.listenerCount("update-available"), 0);

  const zipUpdater = new FixtureUpdater();
  const zip = createAppUpdateService({
    app: packagedApp(),
    autoUpdater: zipUpdater,
    resourcesPath: packageResources("zip"),
  });
  const result = await zip.checkForUpdates();
  assert.equal(result.status, "manual");
  assert.match(result.message, /ZIP\/测试构建/u);
  assert.equal(zipUpdater.listenerCount("update-available"), 0);
});

test("NSIS builds can check, download, and install a discovered update", async () => {
  const updater = new FixtureUpdater({ version: "0.2.0" });
  const service = createAppUpdateService({
    app: packagedApp(),
    autoUpdater: updater,
    resourcesPath: packageResources("nsis"),
  });

  assert.equal(service.status().status, "ready");
  const available = await service.checkForUpdates();
  assert.equal(available.status, "available");
  assert.equal(available.availableVersion, "0.2.0");
  assert.equal(updater.autoDownload, false);

  const downloaded = await service.downloadUpdate();
  assert.equal(downloaded.status, "downloaded");
  assert.equal(updater.downloads, 1);

  const installing = await service.installUpdate();
  assert.equal(installing.status, "installing");
  assert.equal(updater.installs, 1);
});

test("NSIS builds report the current version and an unpublished release without leaking updater errors", async () => {
  const currentUpdater = new FixtureUpdater({ event: "update-not-available", version: "0.1.0" });
  const current = createAppUpdateService({
    app: packagedApp(),
    autoUpdater: currentUpdater,
    resourcesPath: packageResources("nsis"),
  });
  assert.equal((await current.checkForUpdates()).status, "current");

  const unavailableUpdater = new FixtureUpdater({ error: new Error("HTTP Error 404: latest.yml not found") });
  const unavailable = createAppUpdateService({
    app: packagedApp(),
    autoUpdater: unavailableUpdater,
    resourcesPath: packageResources("nsis"),
  });
  const result = await unavailable.checkForUpdates();
  assert.equal(result.status, "unavailable");
  assert.equal(result.message, "还没有发布可用的正式更新。");
});
