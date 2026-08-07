import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserAutomationError,
  executeSiteAutomation,
  executeWebBrowser,
  planSiteAutomation,
  resolveDedicatedBrowserRuntime,
  SITE_ACTION_REGISTRY,
} from "../src/index.mjs";
import { CapabilityExecutionError, consumeCapabilityAuthorization, issueCapabilityAuthorization } from "@suzu-lives/capability-runtime";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function authorization(root, abilityId, action, scope) {
  const issued = issueCapabilityAuthorization({ dataRoot: root, abilityId, action, scope, now: () => 1_000 });
  return consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId, action, scope, now: () => 1_001 });
}

test("dedicated browser paths stay in software data and do not create a profile during planning", () => {
  const root = temporaryDirectory("suzu-browser-");
  const runtime = resolveDedicatedBrowserRuntime({ dataRoot: root });

  assert.equal(runtime.profileDirectory, path.join(root, "capabilities", "web-browser", "chrome-profile"));
  assert.equal(runtime.cdpEndpoint, "http://127.0.0.1:9222");
  assert.equal(runtime.willStartBrowser, false);
  assert.equal(fs.existsSync(runtime.profileDirectory), false);
});

test("browser executor rejects disabled abilities before launching a browser", async () => {
  const root = temporaryDirectory("suzu-browser-gate-");
  const executable = path.join(root, "chrome.exe");
  fs.writeFileSync(executable, "fixture", "utf8");
  let launched = false;
  await assert.rejects(
    () => executeWebBrowser({
      dataRoot: root,
      gate: { enabled: false, configured: true },
      configuration: { executablePath: executable, debugPort: 9333 },
      authorization: {},
      invocation: { scope: { debugPort: 9333 } },
      browserLauncher: async () => { launched = true; },
    }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_DISABLED",
  );
  assert.equal(launched, false);
});

test("browser executor uses a fake process and verifies the Suzu Lives local CDP endpoint before ready", async () => {
  const root = temporaryDirectory("suzu-browser-run-");
  const executable = path.join(root, "chrome.exe");
  fs.writeFileSync(executable, "fixture", "utf8");
  let launch;
  const scope = { debugPort: 9333 };
  const result = await executeWebBrowser({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    configuration: { executablePath: executable, debugPort: 9333 },
    authorization: authorization(root, "web-browser", "start-browser", scope),
    invocation: { scope },
    browserLauncher: async (input) => { launch = input; return { pid: 123, terminate: () => true }; },
    cdpProbe: async (input) => ({ ready: input.cdpEndpoint === "http://127.0.0.1:9333", browser: "Chrome/fixture" }),
  });
  assert.equal(launch.executablePath, executable);
  assert.match(launch.args.join(" "), /remote-debugging-address=127\.0\.0\.1/u);
  assert.equal(result.status, "ready");
  assert.equal(result.cdpEndpoint, "http://127.0.0.1:9333");
  assert.equal(JSON.parse(fs.readFileSync(result.statePath, "utf8")).status, "ready");
});

test("browser startup records failure and terminates only its fake managed process when CDP never becomes ready", async () => {
  const root = temporaryDirectory("suzu-browser-fail-");
  const executable = path.join(root, "chrome.exe");
  fs.writeFileSync(executable, "fixture", "utf8");
  let terminated = false;
  const scope = { debugPort: 9444 };
  await assert.rejects(
    () => executeWebBrowser({
      dataRoot: root,
      gate: { enabled: true, configured: true },
      configuration: { executablePath: executable, debugPort: 9444 },
      authorization: authorization(root, "web-browser", "start-browser", scope),
      invocation: { scope },
      browserLauncher: async () => ({ pid: 124, terminate: () => { terminated = true; } }),
      cdpProbe: async () => ({ ready: false, reason: "fixture not ready" }),
      startupTimeoutMs: 0,
    }),
    BrowserAutomationError,
  );
  assert.equal(terminated, true);
  const state = JSON.parse(fs.readFileSync(path.join(root, "capabilities", "web-browser", "runtime.json"), "utf8"));
  assert.equal(state.status, "failed");
});

test("site plans classify external changes without connecting to a browser", () => {
  const root = temporaryDirectory("suzu-site-");
  const plan = planSiteAutomation({ dataRoot: root, siteId: "douyin", action: "comment", options: { text: "测试" } });

  assert.equal(plan.status, "rejected-high-risk-action");
  assert.equal(plan.willOperateSite, false);
  assert.throws(() => planSiteAutomation({ dataRoot: root, siteId: "unknown", action: "status" }), BrowserAutomationError);
  assert.equal(SITE_ACTION_REGISTRY.douyin.status.allowInvoke, true);
  assert.equal(SITE_ACTION_REGISTRY.douyin.comment.allowInvoke, false);
});

test("site executor only attaches to a verified software-owned local CDP endpoint for allow-listed actions", async () => {
  const root = temporaryDirectory("suzu-site-run-");
  const runtime = resolveDedicatedBrowserRuntime({ dataRoot: root, debugPort: 9222 });
  fs.mkdirSync(path.dirname(runtime.statePath), { recursive: true });
  fs.writeFileSync(runtime.statePath, JSON.stringify({ status: "ready", debugPort: 9222, cdpEndpoint: runtime.cdpEndpoint, profileDirectory: runtime.profileDirectory }), "utf8");
  let adapterInput;
  const scope = { siteId: "douyin", action: "status", optionsDigest: "fixture" };
  const result = await executeSiteAutomation({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    configuration: { siteId: "douyin", siteAuthorized: true },
    siteId: "douyin",
    action: "status",
    authorization: authorization(root, "site-automation", "site:status", scope),
    invocation: { scope },
    cdpProbe: async () => ({ ready: true, browser: "Chrome/fixture" }),
    siteAdapter: async (input) => { adapterInput = input; return { title: "fixture" }; },
  });
  assert.equal(adapterInput.cdpEndpoint, "http://127.0.0.1:9222");
  assert.equal(result.result.title, "fixture");
});

test("site executor refuses high-risk, unknown, and unowned endpoints before an adapter", async () => {
  let called = false;
  const root = temporaryDirectory("suzu-site-reject-");
  const base = {
    dataRoot: root,
    gate: { enabled: true, configured: true },
    configuration: { siteId: "douyin", siteAuthorized: true },
    siteId: "douyin",
    siteAdapter: async () => { called = true; return {}; },
  };
  await assert.rejects(
    () => executeSiteAutomation({ ...base, action: "comment", authorization: {}, invocation: { scope: {} } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "SITE_ACTION_REJECTED",
  );
  await assert.rejects(
    () => executeSiteAutomation({ ...base, action: "unregistered-action", authorization: {}, invocation: { scope: {} } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "SITE_ACTION_NOT_ALLOWED",
  );
  assert.equal(called, false);

  const runtime = resolveDedicatedBrowserRuntime({ dataRoot: root, debugPort: 9222 });
  fs.mkdirSync(path.dirname(runtime.statePath), { recursive: true });
  fs.writeFileSync(runtime.statePath, JSON.stringify({ status: "ready", debugPort: 9222, cdpEndpoint: "http://127.0.0.1:9222", profileDirectory: "C:/not-suzu" }), "utf8");
  const scope = { siteId: "douyin", action: "status", optionsDigest: "fixture" };
  await assert.rejects(
    () => executeSiteAutomation({ ...base, action: "status", authorization: authorization(root, "site-automation", "site:status", scope), invocation: { scope }, cdpProbe: async () => ({ ready: true }) }),
    (error) => error instanceof CapabilityExecutionError && error.code === "BROWSER_CDP_NOT_CONTROLLED",
  );
  assert.equal(called, false);
});
