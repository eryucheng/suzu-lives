import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadConfig,
  loadRegistry,
  loadSiteManifest,
  listSiteAutomationSites,
  isSiteActionEnabled,
  isSiteEnabled,
  resolveSite,
} from "../src/site-automation/common/config.mjs";
import { stopDedicatedBrowser } from "../src/site-automation/common/browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const siteEntry = path.resolve(here, "../src/site-automation/site.mjs");

const DOUYIN_ACTIONS = [
  "status", "close", "observe", "feed", "search", "open-result", "next",
  "enter-live", "exit-live", "play", "like", "comment", "delete-comment",
  "read-comments", "dm-check", "dm-reply", "inspect-owner-image", "group-check",
  "inspect-group-image", "group-reply", "group-request-consent", "understand-shared",
  "share-current", "understand-current", "profile", "back",
];

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("software config keeps browser, diagnostics and Douyin state below the current Agent data root", () => {
  const dataRoot = temporaryDirectory("suzu-browser-data-");
  const projectRoot = temporaryDirectory("suzu-browser-project-");
  const config = loadConfig({ dataRoot, projectRoot });

  assert.ok(config.runtimeRoot.startsWith(dataRoot));
  assert.ok(config.browserRuntimeRoot.startsWith(dataRoot));
  assert.ok(config.diagnosticsDirectory.startsWith(config.runtimeRoot));
  assert.ok(config.actionLogPath.startsWith(config.runtimeRoot));
  assert.ok(config.douyin.actionLogPath.startsWith(config.runtimeRoot));
  assert.ok(config.douyin.media.runtimeDirectory.startsWith(config.runtimeRoot));
  assert.equal(config.sourcePath, path.join(config.runtimeRoot, "config.json"));
  assert.equal(config.sourcePath.includes("ling"), false);
});

test("software config rejects a config file outside its data root", () => {
  const dataRoot = temporaryDirectory("suzu-browser-data-");
  const projectRoot = temporaryDirectory("suzu-browser-project-");
  assert.throws(
    () => loadConfig({ dataRoot, projectRoot, configPath: path.join(projectRoot, "config.local.json") }),
    /软件数据目录/u,
  );
});

test("Douyin close invokes the dedicated browser stopper with the current Agent runtime root", () => {
  let invocation;
  const result = stopDedicatedBrowser({
    browserStartScript: "C:/Suzu/start_browser.py",
    browserRuntimeRoot: "C:/Suzu/agents/agent-a/web-browser",
    pythonCommand: "python",
  }, {
    existsSync: () => true,
    spawnSyncImpl: (...args) => {
      invocation = args;
      return { status: 0, stdout: '{"status":"stopped","processIds":[42]}' };
    },
  });

  assert.deepEqual(result, { status: "stopped", processIds: [42] });
  assert.deepEqual(invocation.slice(0, 2), ["python", ["C:/Suzu/start_browser.py", "--stop"]]);
  assert.equal(invocation[2].env.SUZU_LIVES_BROWSER_RUNTIME_DIR, "C:/Suzu/agents/agent-a/web-browser");
});

test("Douyin registry exposes every registered action and its metadata", () => {
  const registry = loadRegistry();
  const resolved = resolveSite(registry, "抖音");
  assert.equal(resolved.siteId, "douyin");
  const { manifest } = loadSiteManifest(resolved.entry);
  assert.deepEqual(Object.keys(manifest.actions), DOUYIN_ACTIONS);
  assert.equal(manifest.actions.comment.mutating, true);
  assert.equal(manifest.actions.like.mutating, true);
  assert.equal(manifest.actions["group-request-consent"].mutating, true);
  assert.equal(manifest.actions["inspect-group-image"].mutating, false);
});

test("site catalog exposes user-facing Douyin action nodes for the settings UI", () => {
  const sites = listSiteAutomationSites();
  const douyin = sites.find((site) => site.id === "douyin");
  assert.equal(douyin?.name, "抖音");
  assert.equal(douyin?.actions.find((action) => action.id === "feed")?.label, "进入推荐流");
  assert.equal(douyin?.actions.find((action) => action.id === "comment")?.group, "浏览与互动");
});

test("an explicitly disabled site action is rejected before the adapter connects to a browser", () => {
  const dataRoot = temporaryDirectory("suzu-browser-data-");
  const projectRoot = temporaryDirectory("suzu-browser-project-");
  const config = loadConfig({ dataRoot, projectRoot });
  fs.mkdirSync(path.dirname(config.sourcePath), { recursive: true });
  fs.writeFileSync(config.sourcePath, JSON.stringify({ sites: { douyin: { actions: { feed: false } } } }), "utf8");
  assert.equal(isSiteActionEnabled(loadConfig({ dataRoot, projectRoot }), "douyin", "feed"), false);

  const result = spawnSync(process.execPath, [siteEntry, "douyin", "feed", "--data-root", dataRoot, "--project-root", projectRoot], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, "SITE_ACTION_DISABLED");
});

test("an explicitly disabled website is rejected before any of its actions can connect", () => {
  const dataRoot = temporaryDirectory("suzu-browser-data-");
  const projectRoot = temporaryDirectory("suzu-browser-project-");
  const config = loadConfig({ dataRoot, projectRoot });
  fs.mkdirSync(path.dirname(config.sourcePath), { recursive: true });
  fs.writeFileSync(config.sourcePath, JSON.stringify({ sites: { douyin: { enabled: false } } }), "utf8");
  assert.equal(isSiteEnabled(loadConfig({ dataRoot, projectRoot }), "douyin"), false);

  const result = spawnSync(process.execPath, [siteEntry, "douyin", "feed", "--data-root", dataRoot, "--project-root", projectRoot], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, "SITE_DISABLED");
});

test("the owned site entry exposes the list command without starting a browser", () => {
  const output = execFileSync(process.execPath, [siteEntry, "list"], { encoding: "utf8", windowsHide: true });
  const value = JSON.parse(output);
  assert.equal(value.status, "ok");
  assert.equal(value.sites[0].id, "douyin");
  assert.deepEqual(Object.keys(value.sites[0].actions), DOUYIN_ACTIONS);
});
