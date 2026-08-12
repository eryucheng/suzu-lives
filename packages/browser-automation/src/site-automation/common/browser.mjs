import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { SiteAutomationError } from "./runtime.mjs";

async function endpointReady(cdpUrl, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const value = await response.json();
    return Boolean(value.webSocketDebuggerUrl);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startBrowser(config) {
  if (!fs.existsSync(config.browserStartScript)) {
    throw new SiteAutomationError(
      "BROWSER_STARTER_MISSING",
      `Browser starter was not found: ${config.browserStartScript}`,
    );
  }
  const result = spawnSync(config.pythonCommand, [config.browserStartScript], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
    env: {
      ...process.env,
      SUZU_LIVES_BROWSER_RUNTIME_DIR: config.browserRuntimeRoot,
    },
  });
  if (result.status !== 0) {
    throw new SiteAutomationError(
      "BROWSER_START_FAILED",
      (result.stderr || result.stdout || "Dedicated Chrome failed to start.").trim(),
    );
  }
}

/**
 * End only the Chrome process that was started for Suzu Lives' shared
 * software-owned profile. The Python launcher verifies both the debugging
 * port and profile path before calling taskkill, so this cannot target a
 * normal user Chrome window.
 */
export function stopDedicatedBrowser(config, {
  existsSync = fs.existsSync,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!existsSync(config.browserStartScript)) {
    throw new SiteAutomationError(
      "BROWSER_STOPPER_MISSING",
      `Browser starter was not found: ${config.browserStartScript}`,
    );
  }
  const result = spawnSyncImpl(
    config.pythonCommand,
    [config.browserStartScript, "--stop"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
      env: {
        ...process.env,
        SUZU_LIVES_BROWSER_RUNTIME_DIR: config.browserRuntimeRoot,
      },
    },
  );
  if (result.status !== 0) {
    throw new SiteAutomationError(
      "BROWSER_STOP_FAILED",
      (result.stderr || result.stdout || "Dedicated Chrome failed to stop.").trim(),
    );
  }
  const source = String(result.stdout || "").trim();
  try {
    return source ? JSON.parse(source) : { status: "stopped" };
  } catch {
    return { status: "stopped", output: source };
  }
}

export async function connectBrowser(
  config,
  { autoStart = config.autoStartBrowser, optional = false } = {},
) {
  if (!(await endpointReady(config.cdpUrl)) && autoStart) {
    startBrowser(config);
  }
  if (!(await endpointReady(config.cdpUrl))) {
    if (optional) return null;
    throw new SiteAutomationError(
      "BROWSER_NOT_RUNNING",
      `Cannot connect to ${config.cdpUrl}. Start the Suzu Lives dedicated browser first.`,
    );
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new SiteAutomationError(
      "DEPENDENCY_MISSING",
      "playwright-core is missing from this Suzu Lives installation.",
    );
  }

  const browser = await chromium.connectOverCDP(config.cdpUrl, {
    timeout: config.timeoutMs,
  });
  const context = browser.contexts()[0];
  if (!context) {
    throw new SiteAutomationError(
      "BROWSER_CONTEXT_MISSING",
      "Chrome has no available browser context.",
    );
  }
  context.setDefaultTimeout(config.timeoutMs);
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  return { browser, context };
}

function hostnameMatches(url, hostnames) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostnames.some(
      (candidate) =>
        hostname === candidate || hostname.endsWith(`.${candidate}`),
    );
  } catch {
    return false;
  }
}

export function findExistingSitePages(context, manifest) {
  return context
    .pages()
    .filter(
      (candidate) =>
        !candidate.isClosed()
        && hostnameMatches(candidate.url(), manifest.hostnames || []),
    );
}

export async function closeExistingSitePages(context, manifest) {
  const pages = findExistingSitePages(context, manifest);
  let closedPages = 0;
  for (const page of pages) {
    if (page.isClosed()) continue;
    try {
      await page.close({ runBeforeUnload: false });
      closedPages += 1;
    } catch (error) {
      if (page.isClosed()) {
        closedPages += 1;
        continue;
      }
      throw error;
    }
  }
  return {
    status: "ok",
    changed: closedPages > 0,
    closedPages,
  };
}

export async function findOrOpenSitePage(context, manifest) {
  let page = findExistingSitePages(context, manifest)[0];

  if (!page) {
    page = context
      .pages()
      .find((candidate) => candidate.url() === "about:blank");
  }
  if (!page) page = await context.newPage();

  if (!hostnameMatches(page.url(), manifest.hostnames || [])) {
    await page.goto(manifest.homeUrl, { waitUntil: "domcontentloaded" });
  }
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await page.waitForTimeout(600);
  await page.bringToFront();
  return page;
}
