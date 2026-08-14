import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function clean(value) {
  return String(value ?? "").trim();
}

const DATA_ROOT_FOLDER_NAME = "Suzu Lives";
const DATA_ROOT_LOCATOR_DIRECTORY = "suzu-lives-console";
const DATA_ROOT_LOCATOR_FILE_NAME = "data-root.json";
const DATA_ROOT_REDIRECT_FILE_NAME = ".suzu-lives-data-location.json";
const CONTACT_METADATA_DIRECTORY = ".suzu-lives";
const CONTACT_METADATA_FILE = "contact.json";
const CONTACT_ID_PATTERN = /^contact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const AGENT_ID_PATTERN = /^agent-[a-z0-9][a-z0-9_-]{0,121}$/iu;

function absolutePath(value) {
  const candidate = clean(value);
  if (!candidate || !path.isAbsolute(candidate)) return "";
  return path.resolve(candidate);
}

function isFile(filePath) {
  try {
    return Boolean(filePath && fs.statSync(filePath).isFile());
  } catch {
    return false;
  }
}

function isDirectory(directory) {
  try {
    return Boolean(directory && fs.statSync(directory).isDirectory());
  } catch {
    return false;
  }
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return fallback;
  }
}

export function normalizeProjectRoot(projectRoot) {
  const value = clean(projectRoot);
  return value ? path.resolve(value) : "";
}

export function normalizeAgentId(value) {
  const agentId = clean(value).toLowerCase();
  return AGENT_ID_PATTERN.test(agentId) ? agentId : "";
}

function storedContactAgentId(projectRoot) {
  const root = normalizeProjectRoot(projectRoot);
  if (!root) return "";
  const directory = path.join(root, CONTACT_METADATA_DIRECTORY);
  const metadataPath = path.join(directory, CONTACT_METADATA_FILE);
  try {
    const directoryStat = fs.lstatSync(directory);
    const metadataStat = fs.lstatSync(metadataPath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
      || metadataStat.isSymbolicLink() || !metadataStat.isFile()) return "";
    const metadata = readJson(metadataPath, null);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
    if (!CONTACT_ID_PATTERN.test(clean(metadata.id).toLowerCase())) return "";
    return normalizeAgentId(metadata.agentId);
  } catch {
    return "";
  }
}

export function stableAgentId(projectRoot) {
  const root = normalizeProjectRoot(projectRoot);
  if (!root) return "";
  // A Suzu-managed contact carries its identity with the project so its
  // per-contact data does not change when the project directory is moved.
  const persisted = storedContactAgentId(root);
  if (persisted) return persisted;
  return `agent-${createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16)}`;
}

export function suzuLivesDataRootLocatorPath({
  appData = process.env.APPDATA,
  fallbackBase = "",
} = {}) {
  const base = clean(appData) || clean(fallbackBase);
  if (!base) return "";
  return path.join(path.resolve(base), DATA_ROOT_LOCATOR_DIRECTORY, DATA_ROOT_LOCATOR_FILE_NAME);
}

function normalizeMigration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceRoot = absolutePath(value.sourceRoot);
  const targetRoot = absolutePath(value.targetRoot);
  if (!sourceRoot || !targetRoot || sourceRoot === targetRoot) return null;
  return {
    sourceRoot,
    targetRoot,
    createdAt: clean(value.createdAt),
    message: clean(value.message),
  };
}

function normalizeDataRootLocator(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, dataRoot: "", previousDataRoot: "", pendingMigration: null, failedMigration: null };
  }
  return {
    version: 1,
    dataRoot: absolutePath(value.dataRoot),
    previousDataRoot: absolutePath(value.previousDataRoot),
    pendingMigration: normalizeMigration(value.pendingMigration),
    failedMigration: normalizeMigration(value.failedMigration),
  };
}

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

export function readSuzuLivesDataRootLocator({
  appData = process.env.APPDATA,
  fallbackBase = "",
  locatorPath = "",
} = {}) {
  const destination = absolutePath(locatorPath) || suzuLivesDataRootLocatorPath({ appData, fallbackBase });
  if (!destination) return normalizeDataRootLocator();
  return normalizeDataRootLocator(readJson(destination, {}));
}

export function writeSuzuLivesDataRootLocator({
  appData = process.env.APPDATA,
  fallbackBase = "",
  locatorPath = "",
  dataRoot,
  previousDataRoot = "",
  pendingMigration = null,
  failedMigration = null,
} = {}) {
  const destination = absolutePath(locatorPath) || suzuLivesDataRootLocatorPath({ appData, fallbackBase });
  const normalizedRoot = absolutePath(dataRoot);
  if (!destination) throw new Error("无法保存 Suzu Lives 数据目录：缺少 APPDATA 或 locatorPath。");
  if (!normalizedRoot) throw new Error("无法保存 Suzu Lives 数据目录：dataRoot 必须是绝对路径。");
  const value = normalizeDataRootLocator({
    dataRoot: normalizedRoot,
    previousDataRoot,
    pendingMigration,
    failedMigration,
  });
  writeJsonAtomically(destination, value);
  return value;
}

export function suzuLivesDataRootRedirectPath(dataRoot) {
  const root = absolutePath(dataRoot);
  return root ? path.join(root, DATA_ROOT_REDIRECT_FILE_NAME) : "";
}

export function readSuzuLivesDataRootRedirect(dataRoot) {
  const redirectPath = suzuLivesDataRootRedirectPath(dataRoot);
  if (!redirectPath) return "";
  return absolutePath(readJson(redirectPath, {}).dataRoot);
}

export function writeSuzuLivesDataRootRedirect({ dataRoot, targetRoot } = {}) {
  const redirectPath = suzuLivesDataRootRedirectPath(dataRoot);
  const target = absolutePath(targetRoot);
  if (!redirectPath || !target) throw new Error("无法写入 Suzu Lives 数据目录迁移指向。");
  writeJsonAtomically(redirectPath, { version: 1, dataRoot: target });
  return target;
}

function followDataRootRedirect(dataRoot) {
  let current = dataRoot;
  const visited = new Set();
  for (let index = 0; index < 3; index += 1) {
    if (!current || visited.has(current)) break;
    visited.add(current);
    const next = readSuzuLivesDataRootRedirect(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

export function resolveSuzuLivesDataRoot({
  configuredRoot = process.env.SUZU_LIVES_DATA_ROOT,
  localAppData = process.env.LOCALAPPDATA,
  fallbackBase = "",
  appData = process.env.APPDATA,
  locatorPath = "",
  fallbackToLocatorWhenMissing = false,
} = {}) {
  const configured = clean(configuredRoot);
  if (configured) {
    const requested = path.resolve(configured);
    const resolved = followDataRootRedirect(requested);
    // Installed Hooks and bundled CLIs can retain a data-root argument from
    // before a migration. Once that old copy is removed, use the software's
    // current locator instead of recreating a new directory at the stale path.
    if (resolved !== requested || !fallbackToLocatorWhenMissing || isDirectory(requested)) return resolved;
    const located = readSuzuLivesDataRootLocator({ appData, fallbackBase, locatorPath }).dataRoot;
    return located ? followDataRootRedirect(located) : resolved;
  }

  const located = readSuzuLivesDataRootLocator({ appData, fallbackBase, locatorPath }).dataRoot;
  if (located) return followDataRootRedirect(located);

  const base = clean(localAppData) || clean(fallbackBase);
  if (!base) {
    throw new Error("无法定位 Suzu Lives 数据目录：缺少 LOCALAPPDATA 或 fallbackBase。");
  }
  return path.join(path.resolve(base), DATA_ROOT_FOLDER_NAME);
}

export function resolveAgentDataRoot({
  dataRoot,
  projectRoot = "",
  agentId = "",
} = {}) {
  const root = clean(dataRoot);
  if (!root) throw new Error("resolveAgentDataRoot 需要 dataRoot。");

  const identity = clean(agentId) || stableAgentId(projectRoot);
  if (!identity) throw new Error("resolveAgentDataRoot 需要 agentId 或 projectRoot。");

  return path.join(path.resolve(root), "agents", identity);
}

export function resolveAgentConversationDataRoot({
  dataRoot,
  projectRoot = "",
  agentId = "",
  sessionId = "",
} = {}) {
  const session = clean(sessionId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(session)) {
    throw new Error("resolveAgentConversationDataRoot 需要有效的 sessionId。");
  }
  return path.join(resolveAgentDataRoot({ dataRoot, projectRoot, agentId }), "conversations", session);
}

export function encodeClaudeProjectDirectory(projectRoot) {
  const root = normalizeProjectRoot(projectRoot);
  return root ? root.replace(/[^a-zA-Z0-9]/gu, "-") : "";
}
