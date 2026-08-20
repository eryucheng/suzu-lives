import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 25_000;
const MAX_TEXT = 30_000;
const MAX_SCRIPT = 20_000;
const MAX_FILE_ITEMS = 32;
const TAB_ID = /^tab-([1-9][0-9]*)$/u;
const LOCAL_CDP_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class WebBrowserError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WebBrowserError";
    this.code = code;
    this.details = details;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedText(value, label, { maximum = MAX_TEXT, required = false } = {}) {
  const text = clean(value);
  if (text.length > maximum) throw new WebBrowserError("INPUT_TOO_LONG", `${label}不能超过 ${maximum} 个字符。`);
  if (required && !text) throw new WebBrowserError("INPUT_REQUIRED", `${label}不能为空。`);
  return text;
}

function boundedInteger(value, label, { minimum, maximum, fallback } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new WebBrowserError("INPUT_INVALID", `${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return number;
}

function resolveDataRoot(value) {
  const root = clean(value);
  if (!root || !path.isAbsolute(root)) {
    throw new WebBrowserError("DATA_ROOT_REQUIRED", "网页自动化缺少 Suzu Lives 软件数据目录。 ");
  }
  return path.resolve(root);
}

function cdpUrl(value = DEFAULT_CDP_URL) {
  const source = clean(value) || DEFAULT_CDP_URL;
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new WebBrowserError("CDP_URL_INVALID", "浏览器连接地址不是有效 URL。 ");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!/^https?:$/u.test(parsed.protocol) || !LOCAL_CDP_HOSTS.has(hostname)) {
    throw new WebBrowserError("CDP_URL_INVALID", "专用浏览器连接地址必须是本机 http(s) CDP 地址。 ");
  }
  if (!parsed.port) throw new WebBrowserError("CDP_URL_INVALID", "浏览器连接地址必须包含调试端口。 ");
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function cdpPort(value) {
  try {
    return boundedInteger(new URL(value).port, "浏览器调试端口", { minimum: 1024, maximum: 65535, fallback: 9222 });
  } catch (error) {
    if (error instanceof WebBrowserError) throw error;
    throw new WebBrowserError("CDP_URL_INVALID", "浏览器连接地址不是有效 URL。 ");
  }
}

function pathIfAbsolute(value, label) {
  const source = clean(value);
  if (!source) return "";
  if (!path.isAbsolute(source)) throw new WebBrowserError("PATH_INVALID", `${label}必须是绝对路径。`);
  return path.resolve(source);
}

function possibleBrowserExecutables({ env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") {
    const programFiles = clean(env.ProgramFiles);
    const programFilesX86 = clean(env["ProgramFiles(x86)"]);
    const localAppData = clean(env.LOCALAPPDATA);
    return [
      programFiles && path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      programFilesX86 && path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      programFiles && path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      programFilesX86 && path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ].filter(Boolean);
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export function resolveWebBrowserPaths({ dataRoot, outputRoot = "" } = {}) {
  const root = resolveDataRoot(dataRoot);
  const runtimeRoot = path.join(root, "capabilities", "web-browser");
  const outputs = clean(outputRoot) ? pathIfAbsolute(outputRoot, "浏览器输出目录") : path.join(runtimeRoot, "outputs");
  return Object.freeze({
    dataRoot: root,
    runtimeRoot,
    configPath: path.join(runtimeRoot, "config.json"),
    statePath: path.join(runtimeRoot, "runtime.json"),
    profileDirectory: path.join(runtimeRoot, "profile"),
    outputRoot: outputs,
    screenshotDirectory: path.join(outputs, "screenshots"),
    downloadDirectory: path.join(outputs, "downloads"),
  });
}

export function normalizeWebBrowserConfiguration(value = {}, { existsSync = fs.existsSync, env = process.env, platform = process.platform } = {}) {
  const source = plainObject(value);
  const endpoint = cdpUrl(source.cdpUrl);
  const configuredExecutable = pathIfAbsolute(source.executablePath, "浏览器可执行文件");
  const automaticExecutable = possibleBrowserExecutables({ env, platform }).find((candidate) => existsSync(candidate)) || "";
  return Object.freeze({
    cdpUrl: endpoint,
    debugPort: cdpPort(endpoint),
    timeoutMs: boundedInteger(source.timeoutMs, "页面操作等待时间", { minimum: 1_000, maximum: 120_000, fallback: DEFAULT_TIMEOUT_MS }),
    navigationTimeoutMs: boundedInteger(source.navigationTimeoutMs, "页面打开等待时间", { minimum: 1_000, maximum: 180_000, fallback: DEFAULT_NAVIGATION_TIMEOUT_MS }),
    autoStartBrowser: source.autoStartBrowser !== false,
    executablePath: configuredExecutable || automaticExecutable,
  });
}

export async function loadWebBrowserConfiguration({ dataRoot, fsOps = fsp } = {}) {
  const paths = resolveWebBrowserPaths({ dataRoot });
  try {
    const raw = await fsOps.readFile(paths.configPath, "utf8");
    return normalizeWebBrowserConfiguration(JSON.parse(raw.replace(/^\uFEFF/u, "")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeWebBrowserConfiguration({});
    if (error instanceof SyntaxError) throw new WebBrowserError("CONFIG_INVALID", "网页自动化配置文件不是有效 JSON。 ");
    throw error;
  }
}

async function writeJsonAtomic(filePath, value, { fsOps = fsp } = {}) {
  await fsOps.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsOps.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fsOps.rename(temporary, filePath);
}

async function readJson(filePath, { fsOps = fsp } = {}) {
  try {
    return plainObject(JSON.parse((await fsOps.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "")));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function defaultCdpProbe(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  if (typeof fetchImpl !== "function") return { ready: false, reason: "当前环境没有 fetch，无法检查专用浏览器。" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint}/json/version`, { signal: controller.signal });
    if (!response.ok) return { ready: false, reason: `CDP 返回 HTTP ${response.status}。` };
    const value = await response.json();
    const socket = clean(value?.webSocketDebuggerUrl);
    if (!socket) return { ready: false, reason: "CDP 未返回浏览器 WebSocket。" };
    return { ready: true, browser: boundedText(value?.Browser, "浏览器标识", { maximum: 300 }), websocketDebuggerUrl: socket };
  } catch {
    return { ready: false, reason: "专用浏览器尚未启动。" };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(endpoint, { cdpProbe = defaultCdpProbe, startupTimeoutMs = 20_000, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  const deadline = Date.now() + startupTimeoutMs;
  let last = { ready: false, reason: "专用浏览器尚未响应。" };
  while (Date.now() <= deadline) {
    last = await cdpProbe(endpoint);
    if (last?.ready === true) return last;
    await wait(160);
  }
  throw new WebBrowserError("BROWSER_START_TIMEOUT", last?.reason || "等待专用浏览器启动超时。 ");
}

function defaultBrowserLauncher({ executablePath, args }) {
  return spawn(executablePath, args, { detached: false, stdio: "ignore", windowsHide: true });
}

function browserLaunchArguments(paths, configuration) {
  return [
    `--remote-debugging-port=${configuration.debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${paths.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ];
}

export async function getWebBrowserStatus({ dataRoot, configuration = null, cdpProbe = defaultCdpProbe, fsOps = fsp } = {}) {
  const paths = resolveWebBrowserPaths({ dataRoot });
  const config = configuration || await loadWebBrowserConfiguration({ dataRoot, fsOps });
  const [state, probe] = await Promise.all([
    readJson(paths.statePath, { fsOps }),
    cdpProbe(config.cdpUrl),
  ]);
  return Object.freeze({
    status: probe?.ready === true ? "ready" : "stopped",
    cdpUrl: config.cdpUrl,
    profileDirectory: paths.profileDirectory,
    ...(probe?.browser ? { browser: probe.browser } : {}),
    ...(Number.isInteger(Number(state.pid)) && Number(state.pid) > 0 ? { pid: Number(state.pid) } : {}),
    ...(probe?.ready === true ? {} : { reason: clean(probe?.reason) || "专用浏览器未运行。" }),
  });
}

export async function startWebBrowser({
  dataRoot,
  configuration = null,
  browserLauncher = defaultBrowserLauncher,
  cdpProbe = defaultCdpProbe,
  fsOps = fsp,
  wait,
} = {}) {
  const paths = resolveWebBrowserPaths({ dataRoot });
  const config = configuration || await loadWebBrowserConfiguration({ dataRoot, fsOps });
  const existing = await cdpProbe(config.cdpUrl);
  if (existing?.ready === true) {
    return Object.freeze({ status: "ready", alreadyRunning: true, cdpUrl: config.cdpUrl, profileDirectory: paths.profileDirectory, browser: clean(existing.browser) });
  }
  if (!config.executablePath || !fs.existsSync(config.executablePath)) {
    throw new WebBrowserError("BROWSER_EXECUTABLE_MISSING", "找不到 Chrome 或 Edge。请在网页自动化设置中填写浏览器可执行文件。 ");
  }
  if (typeof browserLauncher !== "function") throw new WebBrowserError("BROWSER_LAUNCHER_MISSING", "当前环境无法启动专用浏览器。 ");
  await fsOps.mkdir(paths.profileDirectory, { recursive: true });
  await writeJsonAtomic(paths.statePath, {
    status: "starting",
    startedAt: new Date().toISOString(),
    cdpUrl: config.cdpUrl,
    profileDirectory: paths.profileDirectory,
  }, { fsOps });
  let launched;
  try {
    launched = await browserLauncher({ executablePath: config.executablePath, args: browserLaunchArguments(paths, config), paths, configuration: config });
    launched?.unref?.();
    const probe = await waitForCdp(config.cdpUrl, { cdpProbe, ...(wait ? { wait } : {}) });
    await writeJsonAtomic(paths.statePath, {
      status: "ready",
      startedAt: new Date().toISOString(),
      readyAt: new Date().toISOString(),
      cdpUrl: config.cdpUrl,
      profileDirectory: paths.profileDirectory,
      pid: Number(launched?.pid) || 0,
      browser: clean(probe.browser),
    }, { fsOps });
    return Object.freeze({ status: "ready", cdpUrl: config.cdpUrl, profileDirectory: paths.profileDirectory, pid: Number(launched?.pid) || 0, browser: clean(probe.browser) });
  } catch (error) {
    await writeJsonAtomic(paths.statePath, {
      status: "failed",
      failedAt: new Date().toISOString(),
      cdpUrl: config.cdpUrl,
      profileDirectory: paths.profileDirectory,
      error: clean(error?.message) || "专用浏览器启动失败。",
    }, { fsOps }).catch(() => undefined);
    throw error;
  }
}

function defaultProcessTerminator(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

export async function stopWebBrowser({ dataRoot, fsOps = fsp, processTerminator = defaultProcessTerminator } = {}) {
  const paths = resolveWebBrowserPaths({ dataRoot });
  const state = await readJson(paths.statePath, { fsOps });
  const pid = Number(state.pid);
  const stopped = Number.isInteger(pid) && pid > 0 && typeof processTerminator === "function"
    ? Boolean(await processTerminator(pid))
    : false;
  await writeJsonAtomic(paths.statePath, {
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    cdpUrl: clean(state.cdpUrl) || DEFAULT_CDP_URL,
    profileDirectory: paths.profileDirectory,
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
  }, { fsOps });
  return Object.freeze({ status: "stopped", changed: stopped, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) });
}

async function defaultBrowserConnector(endpoint, configuration) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new WebBrowserError("PLAYWRIGHT_MISSING", "当前安装缺少 Playwright 浏览器连接依赖。 ");
  }
  const browser = await chromium.connectOverCDP(endpoint, { timeout: configuration.timeoutMs });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new WebBrowserError("BROWSER_CONTEXT_MISSING", "专用浏览器没有可用页面上下文。 ");
  }
  context.setDefaultTimeout?.(configuration.timeoutMs);
  context.setDefaultNavigationTimeout?.(configuration.navigationTimeoutMs);
  return { browser, context };
}

async function connectWebBrowser({
  dataRoot,
  configuration = null,
  browserConnector = defaultBrowserConnector,
  browserLauncher = defaultBrowserLauncher,
  cdpProbe = defaultCdpProbe,
  fsOps = fsp,
} = {}) {
  const config = configuration || await loadWebBrowserConfiguration({ dataRoot, fsOps });
  let probe = await cdpProbe(config.cdpUrl);
  if (probe?.ready !== true && config.autoStartBrowser) {
    await startWebBrowser({ dataRoot, configuration: config, browserLauncher, cdpProbe, fsOps });
    probe = await cdpProbe(config.cdpUrl);
  }
  if (probe?.ready !== true) throw new WebBrowserError("BROWSER_NOT_RUNNING", "专用浏览器尚未启动。 ");
  if (typeof browserConnector !== "function") throw new WebBrowserError("BROWSER_CONNECTOR_MISSING", "当前环境无法连接专用浏览器。 ");
  const connection = await browserConnector(config.cdpUrl, config);
  if (!connection?.context || !connection?.browser) throw new WebBrowserError("BROWSER_CONTEXT_MISSING", "专用浏览器连接没有可用页面上下文。 ");
  return { ...connection, configuration: config };
}

function tabsFor(context) {
  return (context.pages?.() || []).filter((page) => !page.isClosed?.());
}

async function tabSummary(page, index) {
  return Object.freeze({
    id: `tab-${index + 1}`,
    url: clean(page.url?.()),
    title: clean(await page.title?.().catch?.(() => "")),
  });
}

async function listTabs(context) {
  return Promise.all(tabsFor(context).map((page, index) => tabSummary(page, index)));
}

function selectedPage(context, requestedTabId = "") {
  const pages = tabsFor(context);
  if (!pages.length) throw new WebBrowserError("TAB_NOT_FOUND", "专用浏览器没有可用标签页。 ");
  const requested = clean(requestedTabId);
  if (!requested) return { page: pages.at(-1), index: pages.length - 1 };
  const match = TAB_ID.exec(requested);
  if (!match) throw new WebBrowserError("TAB_ID_INVALID", "标签页 ID 格式无效。 ");
  const index = Number(match[1]) - 1;
  if (!pages[index]) throw new WebBrowserError("TAB_NOT_FOUND", `找不到标签页 ${requested}。`);
  return { page: pages[index], index };
}

function ensureHttpUrl(value) {
  const source = boundedText(value, "网页地址", { required: true, maximum: 4_000 });
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new WebBrowserError("URL_INVALID", "网页地址不是有效 URL。 ");
  }
  if (!/^https?:$/u.test(parsed.protocol)) throw new WebBrowserError("URL_INVALID", "网页自动化只打开 http(s) 地址。 ");
  return parsed.toString();
}

function actionInput(value) {
  return plainObject(value);
}

function locatorFor(page, raw, label = "页面元素") {
  const input = actionInput(raw);
  const selector = boundedText(input.selector, `${label}选择器`, { maximum: 2_000 });
  const role = boundedText(input.role, `${label}角色`, { maximum: 80 });
  const name = boundedText(input.name, `${label}名称`, { maximum: 1_000 });
  const text = boundedText(input.text, `${label}文本`, { maximum: 2_000 });
  if (selector) return page.locator(selector).first();
  if (role) return page.getByRole(role, name ? { name, exact: input.exact === true } : undefined).first();
  if (text) return page.getByText(text, { exact: input.exact === true }).first();
  throw new WebBrowserError("TARGET_REQUIRED", `${label}需要 selector、role/name 或 text。`);
}

function outputPath(paths, type, supplied, extension) {
  const requested = boundedText(supplied, "输出文件路径", { maximum: 4_000 });
  if (requested) return pathIfAbsolute(requested, "输出文件路径");
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return path.join(type === "screenshot" ? paths.screenshotDirectory : paths.downloadDirectory, `${type}-${timestamp}${extension}`);
}

async function pageSummary(page, index) {
  return Object.freeze({
    id: `tab-${index + 1}`,
    url: clean(page.url?.()),
    title: clean(await page.title?.().catch?.(() => "")),
  });
}

async function snapshotPage(page, index, input) {
  const maximum = boundedInteger(input.maxChars, "页面文本长度", { minimum: 300, maximum: MAX_TEXT, fallback: 12_000 });
  const selector = boundedText(input.selector, "页面读取选择器", { maximum: 2_000 });
  const locator = selector ? page.locator(selector).first() : page.locator("body");
  const text = boundedText(await locator.innerText({ timeout: input.timeoutMs }), "页面文本", { maximum });
  const snapshot = { ...(await pageSummary(page, index)), text };
  if (input.includeInteractables === false) return snapshot;
  const controls = await page.locator("a, button, input, textarea, select, [role='button'], [contenteditable='true']").evaluateAll((elements) => elements.slice(0, 120).map((element) => {
    const attribute = (name) => String(element.getAttribute(name) || "").trim();
    const textContent = String(element.innerText || element.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 240);
    const tag = element.tagName.toLowerCase();
    const id = attribute("id");
    const testId = attribute("data-testid") || attribute("data-test");
    const name = attribute("aria-label") || attribute("name") || attribute("title") || textContent;
    const selector = testId
      ? `[data-testid="${CSS.escape(testId)}"]`
      : id ? `#${CSS.escape(id)}`
        : attribute("name") ? `${tag}[name="${CSS.escape(attribute("name"))}"]`
          : "";
    return {
      tag,
      role: attribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : ""),
      name: name.slice(0, 300),
      text: textContent,
      ...(selector ? { selector } : {}),
    };
  }));
  return { ...snapshot, interactables: controls };
}

async function withConnectedBrowser(options, operation) {
  const connection = await connectWebBrowser(options);
  try {
    return await operation(connection);
  } finally {
    await connection.browser.close?.().catch?.(() => undefined);
  }
}

async function executePageAction({ action, input, dataRoot, outputRoot, ...options }) {
  const paths = resolveWebBrowserPaths({ dataRoot, outputRoot });
  return withConnectedBrowser({ dataRoot, ...options }, async ({ context }) => {
    if (action === "tabs") return { status: "ok", tabs: await listTabs(context) };
    if (action === "open") {
      const url = ensureHttpUrl(input.url);
      let page;
      let index;
      if (input.newTab === true) {
        page = await context.newPage();
        index = tabsFor(context).indexOf(page);
      } else {
        const selected = selectedPage(context, input.tabId);
        page = selected.page;
        index = selected.index;
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      await page.waitForLoadState?.("domcontentloaded").catch?.(() => undefined);
      await page.bringToFront?.();
      return { status: "ok", page: await pageSummary(page, index) };
    }
    const selected = selectedPage(context, input.tabId);
    const page = selected.page;
    if (action === "snapshot") return { status: "ok", page: await snapshotPage(page, selected.index, input) };
    if (action === "screenshot") {
      const target = outputPath(paths, "screenshot", input.outputPath, ".png");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: input.fullPage !== false });
      return { status: "ok", page: await pageSummary(page, selected.index), savedPath: target };
    }
    if (action === "click") {
      await locatorFor(page, input).click({ timeout: input.timeoutMs });
      return { status: "ok", page: await pageSummary(page, selected.index) };
    }
    if (action === "fill") {
      const text = boundedText(input.value ?? input.content, "输入内容", { required: true, maximum: MAX_TEXT });
      await locatorFor(page, input).fill(text, { timeout: input.timeoutMs });
      return { status: "ok", page: await pageSummary(page, selected.index) };
    }
    if (action === "press") {
      const key = boundedText(input.key, "按键", { required: true, maximum: 120 });
      const hasTarget = clean(input.selector) || clean(input.role) || clean(input.text);
      if (hasTarget) await locatorFor(page, input).press(key, { timeout: input.timeoutMs });
      else await page.keyboard.press(key);
      return { status: "ok", page: await pageSummary(page, selected.index) };
    }
    if (action === "scroll") {
      const deltaY = boundedInteger(input.deltaY, "纵向滚动距离", { minimum: -100_000, maximum: 100_000, fallback: 700 });
      const deltaX = boundedInteger(input.deltaX, "横向滚动距离", { minimum: -100_000, maximum: 100_000, fallback: 0 });
      await page.mouse.wheel(deltaX, deltaY);
      return { status: "ok", page: await pageSummary(page, selected.index), deltaX, deltaY };
    }
    if (action === "wait") {
      const milliseconds = boundedInteger(input.milliseconds, "等待时间", { minimum: 0, maximum: 120_000, fallback: 0 });
      const hasTarget = clean(input.selector) || clean(input.role) || clean(input.text);
      if (hasTarget) await locatorFor(page, input).waitFor({ state: boundedText(input.state, "等待状态", { maximum: 40 }) || "visible", timeout: input.timeoutMs });
      else if (milliseconds) await page.waitForTimeout(milliseconds);
      else throw new WebBrowserError("WAIT_REQUIRED", "等待需要目标元素或 milliseconds。 ");
      return { status: "ok", page: await pageSummary(page, selected.index) };
    }
    if (action === "upload") {
      const files = (Array.isArray(input.files) ? input.files : [input.file]).map((value) => boundedText(value, "上传文件", { required: true, maximum: 4_000 }));
      if (!files.length || files.length > MAX_FILE_ITEMS) throw new WebBrowserError("UPLOAD_FILES_INVALID", `一次上传文件数必须在 1 到 ${MAX_FILE_ITEMS} 之间。`);
      const absoluteFiles = files.map((file) => pathIfAbsolute(file, "上传文件"));
      await locatorFor(page, input).setInputFiles(absoluteFiles, { timeout: input.timeoutMs });
      return { status: "ok", page: await pageSummary(page, selected.index), files: absoluteFiles };
    }
    if (action === "download") {
      const target = outputPath(paths, "download", input.outputPath, "");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: input.timeoutMs }),
        locatorFor(page, input).click({ timeout: input.timeoutMs }),
      ]);
      const extension = path.extname(clean(download.suggestedFilename?.())) || "";
      const savedPath = path.extname(target) ? target : `${target}${extension}`;
      await download.saveAs(savedPath);
      return { status: "ok", page: await pageSummary(page, selected.index), savedPath, suggestedFilename: clean(download.suggestedFilename?.()) };
    }
    if (action === "evaluate") {
      const script = boundedText(input.script, "页面脚本", { required: true, maximum: MAX_SCRIPT });
      const value = await page.evaluate(({ source, argument }) => {
        // Deliberately product-provided browser control: this is equivalent to
        // operating the page through DevTools, not a hidden site adapter.
        return Function("argument", source)(argument);
      }, { source: script, argument: input.argument });
      return { status: "ok", page: await pageSummary(page, selected.index), value };
    }
    if (action === "close-tab") {
      await page.close({ runBeforeUnload: false });
      return { status: "ok", closedTabId: `tab-${selected.index + 1}` };
    }
    throw new WebBrowserError("ACTION_UNKNOWN", `未知网页自动化动作：${action}。`);
  });
}

const PAGE_ACTIONS = new Set(["tabs", "open", "snapshot", "screenshot", "click", "fill", "press", "scroll", "wait", "upload", "download", "evaluate", "close-tab"]);

/**
 * Product-owned generic browser entry point. It intentionally contains no
 * website manifests or hard-coded website policies: Agent Core receives the same
 * browser operation set for any http(s) page in the dedicated profile.
 */
export async function executeWebBrowserAction({ action, dataRoot, outputRoot = "", input = {}, ...options } = {}) {
  const operation = boundedText(action, "网页自动化动作", { required: true, maximum: 80 }).toLowerCase();
  if (operation === "status") return getWebBrowserStatus({ dataRoot, ...options });
  if (operation === "start") return startWebBrowser({ dataRoot, ...options });
  if (operation === "stop") return stopWebBrowser({ dataRoot, ...options });
  if (!PAGE_ACTIONS.has(operation)) throw new WebBrowserError("ACTION_UNKNOWN", `未知网页自动化动作：${operation}。`);
  return executePageAction({ action: operation, input: actionInput(input), dataRoot, outputRoot, ...options });
}
