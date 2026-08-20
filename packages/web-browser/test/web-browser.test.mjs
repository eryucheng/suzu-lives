import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeWebBrowserAction,
  getWebBrowserStatus,
  normalizeWebBrowserConfiguration,
  resolveWebBrowserPaths,
  startWebBrowser,
  stopWebBrowser,
} from "../src/index.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeBrowser({ page } = {}) {
  const context = {
    newPage: async () => page,
    pages: () => [page],
    setDefaultNavigationTimeout() {},
    setDefaultTimeout() {},
  };
  return {
    browser: { close: async () => undefined },
    context,
  };
}

function fakePage() {
  const calls = [];
  const locator = {
    click: async () => calls.push(["click"]),
    fill: async (value) => calls.push(["fill", value]),
    first() { return this; },
    innerText: async () => "网页正文",
    setInputFiles: async (files) => calls.push(["upload", files]),
    waitFor: async () => calls.push(["wait"]),
  };
  return {
    calls,
    bringToFront: async () => calls.push(["front"]),
    close: async () => calls.push(["close"]),
    getByRole: () => locator,
    getByText: () => locator,
    goto: async (url) => { calls.push(["goto", url]); },
    isClosed: () => false,
    keyboard: { press: async (key) => calls.push(["press", key]) },
    locator: () => locator,
    mouse: { wheel: async (x, y) => calls.push(["scroll", x, y]) },
    screenshot: async ({ path: target }) => { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "png"); },
    title: async () => "示例网页",
    url: () => "https://example.test/",
    waitForLoadState: async () => undefined,
    waitForTimeout: async (milliseconds) => calls.push(["sleep", milliseconds]),
  };
}

test("web browser paths keep profile global and outputs scoped to the caller", () => {
  const paths = resolveWebBrowserPaths({ dataRoot: "D:/SuzuData", outputRoot: "D:/SuzuData/agents/agent-a/web-browser" });
  assert.equal(paths.profileDirectory, path.join("D:/SuzuData", "capabilities", "web-browser", "profile"));
  assert.equal(paths.screenshotDirectory, path.join("D:/SuzuData", "agents", "agent-a", "web-browser", "screenshots"));
});

test("web browser configuration uses a dedicated local CDP endpoint", () => {
  const configuration = normalizeWebBrowserConfiguration({ cdpUrl: "http://127.0.0.1:9333/", timeoutMs: 3000 }, { existsSync: () => false });
  assert.equal(configuration.cdpUrl, "http://127.0.0.1:9333");
  assert.equal(configuration.debugPort, 9333);
  assert.equal(configuration.timeoutMs, 3000);
  assert.equal(normalizeWebBrowserConfiguration({ cdpUrl: "http://[::1]:9333" }, { existsSync: () => false }).debugPort, 9333);
  assert.throws(() => normalizeWebBrowserConfiguration({ cdpUrl: "https://remote.example.test:9222" }), /本机/);
});

test("start, status, and stop use only the tracked dedicated browser process", async () => {
  const root = await temporaryDirectory("suzu-web-browser-");
  const executable = path.join(root, "chrome.exe");
  await fs.writeFile(executable, "fixture");
  let ready = false;
  const cdpProbe = async () => ready ? { ready: true, browser: "Fixture Chrome" } : { ready: false };
  const started = await startWebBrowser({
    dataRoot: root,
    configuration: normalizeWebBrowserConfiguration({ executablePath: executable }),
    browserLauncher: () => { ready = true; return { pid: 8123, unref() {} }; },
    cdpProbe,
    wait: async () => undefined,
  });
  assert.equal(started.status, "ready");
  const status = await getWebBrowserStatus({ dataRoot: root, cdpProbe });
  assert.equal(status.status, "ready");
  let terminated = 0;
  const stopped = await stopWebBrowser({ dataRoot: root, processTerminator: (pid) => { terminated = pid; return true; } });
  assert.equal(stopped.changed, true);
  assert.equal(terminated, 8123);
});

test("generic page actions operate an arbitrary page and save output under the caller scope", async () => {
  const root = await temporaryDirectory("suzu-web-browser-actions-");
  const outputRoot = path.join(root, "agents", "agent-a", "web-browser");
  const page = fakePage();
  const common = {
    dataRoot: root,
    outputRoot,
    configuration: normalizeWebBrowserConfiguration({ autoStartBrowser: false }),
    cdpProbe: async () => ({ ready: true }),
    browserConnector: async () => fakeBrowser({ page }),
  };
  await executeWebBrowserAction({ ...common, action: "open", input: { url: "https://example.test/path" } });
  await executeWebBrowserAction({ ...common, action: "fill", input: { selector: "#message", value: "hello" } });
  await executeWebBrowserAction({ ...common, action: "click", input: { role: "button", name: "发送" } });
  const screenshot = await executeWebBrowserAction({ ...common, action: "screenshot", input: {} });
  assert.deepEqual(page.calls.slice(0, 3), [["goto", "https://example.test/path"], ["front"], ["fill", "hello"]]);
  assert.ok(page.calls.some((entry) => entry[0] === "click"));
  assert.ok(screenshot.savedPath.startsWith(outputRoot));
  assert.equal(await fs.readFile(screenshot.savedPath, "utf8"), "png");
});
