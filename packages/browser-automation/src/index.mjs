import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CapabilityExecutionError, assertInvocationGate, assertVerifiedCapabilityAuthorization } from "@suzu-lives/capability-runtime";

export { listSiteAutomationSites } from "./site-automation/common/config.mjs";

export class BrowserAutomationError extends Error {}

/**
 * This is the only site/action registry the software executor consults.
 * Known high-risk actions remain named here so they are rejected
 * explicitly rather than accidentally becoming executable through an adapter.
 */
export const SITE_ACTION_REGISTRY = Object.freeze({
  douyin: Object.freeze({
    status: Object.freeze({ label: "读取当前状态", risk: "low", allowInvoke: true }),
    observe: Object.freeze({ label: "观察当前页面", risk: "low", allowInvoke: true }),
    "read-comments": Object.freeze({ label: "读取当前可见评论", risk: "low", allowInvoke: true }),
    comment: Object.freeze({ label: "发布评论", risk: "high", allowInvoke: false }),
    "delete-comment": Object.freeze({ label: "删除评论", risk: "high", allowInvoke: false }),
    "dm-reply": Object.freeze({ label: "回复私信", risk: "high", allowInvoke: false }),
    "group-reply": Object.freeze({ label: "群聊回复", risk: "high", allowInvoke: false }),
    "group-request-consent": Object.freeze({ label: "群隐私请求", risk: "high", allowInvoke: false }),
    "share-current": Object.freeze({ label: "分享当前内容", risk: "high", allowInvoke: false }),
    like: Object.freeze({ label: "点赞", risk: "high", allowInvoke: false }),
  }),
});

function clean(value) {
  return String(value ?? "").trim();
}

function requiredDataRoot(value) {
  const root = clean(value);
  if (!root) throw new BrowserAutomationError("缺少 Suzu Lives 软件数据目录。");
  return path.resolve(root);
}

function requiredSiteId(value) {
  const siteId = clean(value).toLowerCase();
  if (!Object.hasOwn(SITE_ACTION_REGISTRY, siteId)) throw new BrowserAutomationError("该网站尚未登记到 Suzu Lives 的站点能力中。");
  return siteId;
}

function boundedAction(value) {
  const action = clean(value).toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(action)) throw new BrowserAutomationError("站点动作格式无效。");
  return action;
}

function positivePort(value, fallback = 9222) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new BrowserAutomationError("浏览器调试端口必须在 1024 到 65535 之间。");
  return port;
}

function actionDefinition(siteId, action) {
  const definition = SITE_ACTION_REGISTRY[siteId]?.[action];
  if (!definition) {
    throw new CapabilityExecutionError("SITE_ACTION_NOT_ALLOWED", `Suzu Lives 未登记站点动作 ${siteId}/${action}，已拒绝调用。`, { siteId, action });
  }
  if (definition.allowInvoke !== true || definition.risk !== "low") {
    throw new CapabilityExecutionError("SITE_ACTION_REJECTED", `站点动作 ${siteId}/${action} 属于高风险或未开放动作，已拒绝调用。`, { siteId, action, risk: definition.risk });
  }
  return definition;
}

function browserStatePath(dataRoot) {
  return path.join(requiredDataRoot(dataRoot), "capabilities", "web-browser", "runtime.json");
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

async function readJsonIfPresent(filePath, fallback = {}) {
  try {
    const value = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new BrowserAutomationError(`无法读取软件浏览器状态：${clean(error.message) || "未知错误"}`);
  }
}

function localCdpEndpoint(port) {
  return `http://127.0.0.1:${positivePort(port)}`;
}

function assertControlledCdpEndpoint(value, expectedPort) {
  let parsed;
  try { parsed = new URL(clean(value)); } catch { throw new BrowserAutomationError("浏览器 CDP endpoint 无效。 "); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== positivePort(expectedPort)) {
    throw new BrowserAutomationError("浏览器 CDP endpoint 必须是 Suzu Lives 自有的 127.0.0.1 本机端口。 ");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function validateCdpVersion(value, endpoint, debugPort) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ready: false, reason: "CDP /json/version 返回无效。" };
  const controlledEndpoint = assertControlledCdpEndpoint(endpoint, debugPort);
  const browser = clean(value.Browser || value.browser);
  const websocket = clean(value.webSocketDebuggerUrl || value.websocketDebuggerUrl);
  if (!browser || !websocket) return { ready: false, reason: "CDP /json/version 未确认浏览器。" };
  let websocketUrl;
  try { websocketUrl = new URL(websocket); } catch { return { ready: false, reason: "CDP WebSocket 地址无效。" }; }
  if (!new Set(["ws:", "wss:"]).has(websocketUrl.protocol) || websocketUrl.hostname !== "127.0.0.1" || Number(websocketUrl.port) !== positivePort(debugPort)) {
    return { ready: false, reason: "CDP WebSocket 不属于软件受控的本机端口。" };
  }
  return { ready: true, cdpEndpoint: controlledEndpoint, browser: browser.slice(0, 300), websocketDebuggerUrl: websocket };
}

async function defaultCdpProbe({ cdpEndpoint, debugPort, fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  if (typeof fetchImpl !== "function") return { ready: false, reason: "缺少本机 CDP HTTP 客户端。" };
  const endpoint = assertControlledCdpEndpoint(cdpEndpoint, debugPort);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint}/json/version`, { signal: controller.signal });
    if (!response?.ok) return { ready: false, reason: `CDP HTTP ${response?.status || 0}` };
    const payload = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
    return validateCdpVersion(payload, endpoint, debugPort);
  } catch (error) {
    return { ready: false, reason: clean(error?.message) || "无法连接本机 CDP。" };
  } finally {
    clearTimeout(timer);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForControlledCdp({ cdpEndpoint, debugPort, cdpProbe = defaultCdpProbe, startupTimeoutMs = 15_000, waitImpl = wait } = {}) {
  const started = Date.now();
  let last = { ready: false, reason: "尚未检查" };
  do {
    last = await cdpProbe({ cdpEndpoint, debugPort });
    if (last?.ready === true) return last;
    if (Date.now() - started >= startupTimeoutMs) break;
    await waitImpl(Math.min(200, Math.max(1, startupTimeoutMs - (Date.now() - started))));
  } while (true);
  throw new BrowserAutomationError(`Suzu Lives 专用浏览器未在受控 CDP endpoint 就绪：${clean(last?.reason) || "超时"}`);
}

function defaultBrowserLauncher({ executablePath, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid || 0, terminate: () => { try { return child.kill(); } catch { return false; } } });
    });
  });
}

async function stopManagedProcess(process) {
  if (typeof process?.terminate === "function") {
    try { await process.terminate(); } catch { /* A failed cleanup is recorded by the caller. */ }
  }
}

async function defaultReadOnlySiteAdapter({ cdpEndpoint, siteId, action, options }) {
  let playwrightCore;
  try {
    playwrightCore = await import("playwright-core");
  } catch {
    throw new BrowserAutomationError("缺少 Playwright 站点适配器；请在 Suzu Lives 安装中配置该软件依赖。 ");
  }
  const browser = await playwrightCore.chromium.connectOverCDP(cdpEndpoint);
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => new URL(candidate.url()).hostname.endsWith("douyin.com"));
    if (!page) throw new BrowserAutomationError(`专用浏览器中没有已打开的 ${siteId} 页面。`);
    const url = page.url();
    if (action === "status") return { siteId, action, url, title: await page.title() };
    if (action === "observe") {
      const text = clean(await page.locator("body").innerText({ timeout: 5_000 })).slice(0, 4_000);
      return { siteId, action, url, title: await page.title(), text };
    }
    if (action === "read-comments") {
      const maximum = Math.min(Math.max(Number(options?.limit) || 20, 1), 50);
      const comments = (await page.locator("[data-e2e='video-comment-item']").allInnerTexts()).slice(0, maximum).map((item) => clean(item)).filter(Boolean);
      return { siteId, action, url, comments };
    }
    throw new CapabilityExecutionError("SITE_ACTION_NOT_ALLOWED", `站点动作 ${siteId}/${action} 未实现。`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function playwrightAvailable() {
  try {
    await import("playwright-core");
    return true;
  } catch {
    return false;
  }
}

export function resolveDedicatedBrowserRuntime({ dataRoot, debugPort = 9222 } = {}) {
  const root = path.join(requiredDataRoot(dataRoot), "capabilities", "web-browser");
  const port = positivePort(debugPort);
  return {
    abilityId: "site-automation",
    runtimeDataRoot: root,
    profileDirectory: path.join(root, "chrome-profile"),
    diagnosticsDirectory: path.join(root, "diagnostics"),
    statePath: path.join(root, "runtime.json"),
    cdpEndpoint: localCdpEndpoint(port),
    debugPort: port,
    willStartBrowser: false,
    willAttachBrowser: false,
    requiresManualLogin: true,
  };
}

export function planSiteAutomation({ dataRoot, siteId, action, options = {} } = {}) {
  const browser = resolveDedicatedBrowserRuntime({ dataRoot });
  const resolvedSiteId = requiredSiteId(siteId);
  const resolvedAction = boundedAction(action);
  const registered = SITE_ACTION_REGISTRY[resolvedSiteId][resolvedAction];
  const requiresConfirmation = registered?.risk === "high";
  return {
    abilityId: "site-automation",
    siteId: resolvedSiteId,
    action: resolvedAction,
    options: options && typeof options === "object" && !Array.isArray(options) ? { ...options } : {},
    status: !registered ? "rejected-unregistered-action" : requiresConfirmation ? "rejected-high-risk-action" : "requires-browser-and-site-authorization",
    dependency: { browserProfileDirectory: browser.profileDirectory, cdpEndpoint: browser.cdpEndpoint },
    willStartBrowser: false,
    willAttachBrowser: false,
    willNavigate: false,
    willOperateSite: false,
    nextRequirement: !registered
      ? "该动作未登记到 Suzu Lives 站点注册表，不能调用。"
      : requiresConfirmation
        ? "高风险外部站点动作在当前软件版本中默认拒绝，不会交给浏览器适配器。"
        : "需要用户先在 Suzu Lives 专用浏览器中完成登录、由软件确认本机 CDP 就绪，并为本次只读动作签发授权。",
  };
}

/** Start only a dedicated profile and prove its 127.0.0.1 CDP endpoint is ready. */
export async function executeSiteAutomationBrowser({
  dataRoot,
  gate,
  configuration = {},
  authorization,
  invocation,
  browserLauncher = defaultBrowserLauncher,
  cdpProbe = defaultCdpProbe,
  startupTimeoutMs,
  waitImpl,
  now = () => new Date(),
} = {}) {
  assertInvocationGate({ abilityId: "site-automation", gate, dependencies: {} });
  assertVerifiedCapabilityAuthorization({ authorization, abilityId: "site-automation", action: "start-browser", scope: invocation?.scope });
  const configuredExecutable = clean(configuration.executablePath);
  const executablePath = configuredExecutable ? path.resolve(configuredExecutable) : "";
  const debugPort = positivePort(configuration.debugPort);
  assertInvocationGate({
    abilityId: "site-automation",
    gate,
    dependencies: { "专用 Chrome 可执行文件": Boolean(executablePath && fs.existsSync(executablePath)), "浏览器启动器": typeof browserLauncher === "function", "本机 CDP 探针": typeof cdpProbe === "function" },
  });
  const runtime = resolveDedicatedBrowserRuntime({ dataRoot, debugPort });
  const prior = await readJsonIfPresent(runtime.statePath, {});
  if (prior.status === "ready" && prior.cdpEndpoint === runtime.cdpEndpoint && Number(prior.debugPort) === runtime.debugPort) {
    const existing = await cdpProbe({ cdpEndpoint: runtime.cdpEndpoint, debugPort: runtime.debugPort });
    if (existing?.ready === true) {
      return { abilityId: "site-automation", status: "ready", alreadyRunning: true, profileDirectory: runtime.profileDirectory, cdpEndpoint: runtime.cdpEndpoint, statePath: runtime.statePath, manualLoginRequired: true, browser: existing.browser };
    }
  }
  await fsp.mkdir(runtime.profileDirectory, { recursive: true });
  const args = [
    `--remote-debugging-port=${runtime.debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${runtime.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ];
  await writeJsonAtomic(runtime.statePath, { status: "starting", startedAt: now().toISOString(), debugPort: runtime.debugPort, cdpEndpoint: runtime.cdpEndpoint, profileDirectory: runtime.profileDirectory });
  let launched;
  try {
    launched = await browserLauncher({ executablePath, args, runtime });
    const cdp = await waitForControlledCdp({ cdpEndpoint: runtime.cdpEndpoint, debugPort: runtime.debugPort, cdpProbe, startupTimeoutMs, waitImpl });
    const readyAt = now().toISOString();
    await writeJsonAtomic(runtime.statePath, { status: "ready", startedAt: now().toISOString(), readyAt, debugPort: runtime.debugPort, cdpEndpoint: runtime.cdpEndpoint, profileDirectory: runtime.profileDirectory, pid: Number(launched?.pid) || 0, browser: cdp.browser });
    return { abilityId: "site-automation", status: "ready", profileDirectory: runtime.profileDirectory, cdpEndpoint: runtime.cdpEndpoint, statePath: runtime.statePath, manualLoginRequired: true, process: launched && typeof launched === "object" ? { pid: Number(launched.pid) || 0 } : undefined, browser: cdp.browser };
  } catch (error) {
    await stopManagedProcess(launched);
    await writeJsonAtomic(runtime.statePath, { status: "failed", failedAt: now().toISOString(), debugPort: runtime.debugPort, cdpEndpoint: runtime.cdpEndpoint, profileDirectory: runtime.profileDirectory, error: clean(error?.message).slice(0, 500) || "browser startup failed" });
    if (error instanceof CapabilityExecutionError || error instanceof BrowserAutomationError) throw error;
    throw new BrowserAutomationError(`专用浏览器无法启动：${clean(error?.message) || "未知错误"}`);
  }
}

/**
 * Only a read-only entry in SITE_ACTION_REGISTRY reaches a site adapter. The
 * endpoint is derived from a Suzu Lives-owned browser state record and probed
 * again immediately before the adapter attaches.
 */
export async function executeSiteAutomation({
  dataRoot,
  gate,
  configuration = {},
  authorization,
  invocation,
  siteId = "douyin",
  action = "status",
  options = {},
  siteAdapter,
  dependencyProbe,
  cdpProbe = defaultCdpProbe,
} = {}) {
  assertInvocationGate({ abilityId: "site-automation", gate, dependencies: {} });
  const resolvedSiteId = requiredSiteId(siteId);
  const resolvedAction = boundedAction(action);
  actionDefinition(resolvedSiteId, resolvedAction);
  assertVerifiedCapabilityAuthorization({ authorization, abilityId: "site-automation", action: `site:${resolvedAction}`, scope: invocation?.scope });
  const configuredSite = requiredSiteId(configuration.siteId || resolvedSiteId);
  if (configuredSite !== resolvedSiteId || configuration.siteAuthorized !== true) {
    throw new CapabilityExecutionError("SITE_NOT_AUTHORIZED", `站点 ${resolvedSiteId} 尚未在 Suzu Lives 中完成授权，已拒绝调用。`, { siteId: resolvedSiteId });
  }
  const statePath = browserStatePath(dataRoot);
  const browserState = await readJsonIfPresent(statePath, {});
  if (browserState.status !== "ready") {
    throw new CapabilityExecutionError("BROWSER_CDP_NOT_READY", "Suzu Lives 专用浏览器尚未完成受控 CDP 就绪检查，已拒绝连接站点。", { abilityId: "site-automation" });
  }
  const debugPort = positivePort(browserState.debugPort);
  const runtime = resolveDedicatedBrowserRuntime({ dataRoot, debugPort });
  if (browserState.cdpEndpoint !== runtime.cdpEndpoint || browserState.profileDirectory !== runtime.profileDirectory) {
    throw new CapabilityExecutionError("BROWSER_CDP_NOT_CONTROLLED", "浏览器状态不属于当前 Suzu Lives 专用 profile，已拒绝连接站点。", { abilityId: "site-automation" });
  }
  const adapter = siteAdapter || defaultReadOnlySiteAdapter;
  assertInvocationGate({ abilityId: "site-automation", gate, dependencies: { "站点适配器": typeof adapter === "function", "本机 CDP 探针": typeof cdpProbe === "function" } });
  const cdp = await cdpProbe({ cdpEndpoint: runtime.cdpEndpoint, debugPort });
  assertInvocationGate({ abilityId: "site-automation", gate, dependencies: { "受控本机 CDP": cdp?.ready === true } });
  const available = dependencyProbe ? await dependencyProbe({ cdpEndpoint: runtime.cdpEndpoint, siteId: resolvedSiteId }) : siteAdapter ? true : await playwrightAvailable();
  assertInvocationGate({ abilityId: "site-automation", gate, dependencies: { "受控站点运行时": available === true } });
  const result = await adapter({ dataRoot: requiredDataRoot(dataRoot), cdpEndpoint: runtime.cdpEndpoint, siteId: resolvedSiteId, action: resolvedAction, options: options && typeof options === "object" && !Array.isArray(options) ? { ...options } : {} });
  return { abilityId: "site-automation", status: "ok", siteId: resolvedSiteId, action: resolvedAction, cdpEndpoint: runtime.cdpEndpoint, result };
}
