import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ATTACHMENT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const ZSTD_MAGIC = 0xFD2FB528;
const ZSTD_CHECKSUM_OPTIONS = {
  params: {
    [zlibConstants.ZSTD_c_checksumFlag]: 1,
  },
};

export class AgentSessionStorageError extends Error {
  constructor(message, { cause, code = "AGENT_SESSION_STORAGE_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AgentSessionStorageError";
    this.code = code;
  }
}


function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function requiredAbsoluteDirectory(value, label) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) {
    throw new AgentSessionStorageError(`${label}必须是绝对目录。`, { code: "DIRECTORY_REQUIRED" });
  }
  return path.resolve(source);
}

function requiredSessionId(value) {
  const id = clean(value);
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new AgentSessionStorageError("Agent Core 会话标识无效。", { code: "SESSION_ID_INVALID" });
  }
  return id;
}

function containedChild(root, candidate, label) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentSessionStorageError(`${label}超出了 Suzu 管理的 Agent Core 数据目录。`, { code: "PATH_OUTSIDE_ROOT" });
  }
  return target;
}

/** Mirrors Agent Core's documented `encodeSegment()` persistence helper. */
export function encodeAgentSessionSegment(value) {
  const raw = clean(value);
  if (!raw) throw new AgentSessionStorageError("Agent Core 存储路径缺少会话标识。", { code: "SESSION_ID_INVALID" });
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) encoded += character;
    else encoded += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

/** Mirrors Agent Core's documented `projectKey()` JSONL persistence helper. */
export function agentProjectDirectoryName(value) {
  const cwd = requiredAbsoluteDirectory(value, "Agent Core 工作目录");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/u, "") || "root").slice(0, 251)}--`;
}

/**
 * Computes only the stable, product-owned Agent Core persistence paths.  The layout
 * is Agent Core's JSONL storage contract: `$SUZU_AGENT_HOME/sessions/<project-key>/<id>`.
 * Keeping it isolated here lets contact deletion validate every destructive
 * target before touching it.
 */
export function resolveAgentSessionStoragePaths({ runtimeHome, projectRoot, sessionId } = {}) {
  const home = requiredAbsoluteDirectory(runtimeHome, "Agent Core 运行时目录");
  const cwd = requiredAbsoluteDirectory(projectRoot, "联系人工作目录");
  const id = requiredSessionId(sessionId);
  const sessionsRoot = path.join(home, "sessions");
  const projectDirectory = containedChild(sessionsRoot, path.join(sessionsRoot, agentProjectDirectoryName(cwd)), "Agent 项目目录");
  const sessionDirectory = containedChild(projectDirectory, path.join(projectDirectory, encodeAgentSessionSegment(id)), "Agent 会话目录");
  const storagesRoot = path.join(home, "storages");
  return Object.freeze({
    attachmentObjectsRoot: path.join(home, "attachments", "v1", "objects"),
    projectDirectory,
    runtimeHome: home,
    sessionDirectory,
    sessionId: id,
    sessionProjectionCacheFile: path.join(storagesRoot, "session_projcache.json"),
    sessionsRoot,
    workspaceFile: path.join(storagesRoot, "workspace.json"),
  });
}

function ordinaryDirectorySync(directory, label) {
  let stat;
  try {
    stat = fsSync.lstatSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new AgentSessionStorageError(`${label}无法读取。`, { cause: error, code: "STORAGE_DIRECTORY_INVALID" });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AgentSessionStorageError(`${label}不是可安全操作的普通目录。`, { code: "UNSAFE_STORAGE_DIRECTORY" });
  }
  try {
    return fsSync.realpathSync(directory);
  } catch (error) {
    throw new AgentSessionStorageError(`${label}无法解析真实路径。`, { cause: error, code: "STORAGE_DIRECTORY_INVALID" });
  }
}

function ordinaryFileSync(filePath, label) {
  let stat;
  try {
    stat = fsSync.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new AgentSessionStorageError(`${label}无法读取。`, { cause: error, code: "STORAGE_FILE_INVALID" });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AgentSessionStorageError(`${label}不是可安全操作的普通文件。`, { code: "UNSAFE_STORAGE_FILE" });
  }
  return true;
}

function writeFileAtomicSync(filePath, content, label) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.suzu-relocate-${randomUUID()}.tmp`);
  try {
    fsSync.writeFileSync(temporary, content, { flag: "wx" });
    fsSync.renameSync(temporary, filePath);
  } catch (error) {
    try { fsSync.rmSync(temporary, { force: true }); } catch { /* Best effort only. */ }
    throw new AgentSessionStorageError(`${label}无法原子更新。`, { cause: error, code: "STORAGE_WRITE_FAILED" });
  }
}

/** Reads the end offset of the first complete Zstandard frame without
 * decompressing later event frames. Agent Core stores the session header in exactly
 * that first, independently decodable frame. */
function firstZstdFrameEnd(source) {
  const buffer = Buffer.from(source);
  let offset = 0;
  if (buffer.length < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new AgentSessionStorageError("Agent Core Zstandard 会话文件的首帧无效。", { code: "SESSION_ARTIFACT_INVALID" });
  }
  offset += 4;
  if (offset === buffer.length) throw new AgentSessionStorageError("Agent Core Zstandard 会话文件缺少帧头。", { code: "SESSION_ARTIFACT_INVALID" });
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  if ((descriptor & 24) !== 0) {
    throw new AgentSessionStorageError("Agent Core Zstandard 会话文件包含不支持的帧头。", { code: "SESSION_ARTIFACT_INVALID" });
  }
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buffer.length - offset < remainingHeaderBytes) {
    throw new AgentSessionStorageError("Agent Core Zstandard 会话文件的首帧不完整。", { code: "SESSION_ARTIFACT_INVALID" });
  }
  offset += remainingHeaderBytes;
  for (;;) {
    if (buffer.length - offset < 3) {
      throw new AgentSessionStorageError("Agent Core Zstandard 会话文件的首帧不完整。", { code: "SESSION_ARTIFACT_INVALID" });
    }
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) {
      throw new AgentSessionStorageError("Agent Core Zstandard 会话文件包含保留块类型。", { code: "SESSION_ARTIFACT_INVALID" });
    }
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) {
      throw new AgentSessionStorageError("Agent Core Zstandard 会话文件的首帧不完整。", { code: "SESSION_ARTIFACT_INVALID" });
    }
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) {
    if (buffer.length - offset < 4) {
      throw new AgentSessionStorageError("Agent Core Zstandard 会话文件的首帧校验不完整。", { code: "SESSION_ARTIFACT_INVALID" });
    }
    offset += 4;
  }
  return offset;
}

function parsedSessionHeader(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value ?? "").trim());
  } catch (error) {
    throw new AgentSessionStorageError("Agent Core 会话文件的头信息无法读取。", { cause: error, code: "SESSION_ARTIFACT_INVALID" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.type !== "session" || !clean(parsed.id)
    || !clean(parsed.cwd) || !path.isAbsolute(parsed.cwd)) {
    throw new AgentSessionStorageError("Agent Core 会话文件的头信息无效。", { code: "SESSION_ARTIFACT_INVALID" });
  }
  return parsed;
}

function relocatedHeaderContent(header, targetProjectRoot) {
  return Buffer.from(`${JSON.stringify({ ...header, cwd: targetProjectRoot })}\n`, "utf8");
}

function rewriteSessionHeaderSync(filePath, { sourceProjectRoot, targetProjectRoot, zstd }) {
  const artifact = fsSync.readFileSync(filePath);
  if (!zstd) {
    const lineEnd = artifact.indexOf(0x0A);
    if (lineEnd < 0) {
      throw new AgentSessionStorageError("Agent Core JSONL 会话文件缺少头信息。", { code: "SESSION_ARTIFACT_INVALID" });
    }
    const header = parsedSessionHeader(artifact.subarray(0, lineEnd));
    if (!samePath(header.cwd, sourceProjectRoot)) return false;
    writeFileAtomicSync(filePath, Buffer.concat([
      relocatedHeaderContent(header, targetProjectRoot),
      artifact.subarray(lineEnd + 1),
    ]), "Agent Core JSONL 会话文件");
    return true;
  }

  const frameEnd = firstZstdFrameEnd(artifact);
  let headerFrame;
  try {
    headerFrame = zstdDecompressSync(artifact.subarray(0, frameEnd));
  } catch (error) {
    throw new AgentSessionStorageError("Agent Core Zstandard 会话头无法解压。", { cause: error, code: "SESSION_ARTIFACT_INVALID" });
  }
  const headerText = headerFrame.toString("utf8");
  if (!headerText.endsWith("\n") || headerText.indexOf("\n") !== headerText.length - 1) {
    throw new AgentSessionStorageError("Agent Core Zstandard 会话头格式无效。", { code: "SESSION_ARTIFACT_INVALID" });
  }
  const header = parsedSessionHeader(headerText);
  if (!samePath(header.cwd, sourceProjectRoot)) return false;
  let nextHeaderFrame;
  try {
    nextHeaderFrame = zstdCompressSync(relocatedHeaderContent(header, targetProjectRoot), ZSTD_CHECKSUM_OPTIONS);
  } catch (error) {
    throw new AgentSessionStorageError("Agent Core Zstandard 会话头无法重新压缩。", { cause: error, code: "SESSION_ARTIFACT_INVALID" });
  }
  writeFileAtomicSync(filePath, Buffer.concat([nextHeaderFrame, artifact.subarray(frameEnd)]), "Agent Core Zstandard 会话文件");
  return true;
}

function relocateWorkspaceIndexSync(runtimeHome, { sourceProjectRoot, targetProjectRoot }) {
  const filePath = path.join(runtimeHome, "storages", "workspace.json");
  if (!ordinaryFileSync(filePath, "Agent Core 工作区索引")) return 0;
  let document;
  try {
    document = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new AgentSessionStorageError("Agent Core 工作区索引无法读取。", { cause: error, code: "STORAGE_UNIT_INVALID" });
  }
  const unit = plainObject(document?.unit);
  const tables = plainObject(document?.tables);
  const workspaces = plainObject(tables.workspaces);
  if (unit.name !== "workspace" || !Number.isInteger(unit.version) || !document?.global || !document?.tables || Array.isArray(document.tables)) {
    throw new AgentSessionStorageError("Agent Core 工作区索引的格式不受当前版本支持。", { code: "STORAGE_UNIT_INVALID" });
  }
  let changed = 0;
  const nextWorkspaces = {};
  for (const [id, value] of Object.entries(workspaces)) {
    const workspace = plainObject(value);
    if (clean(workspace.path) && path.isAbsolute(workspace.path) && samePath(workspace.path, sourceProjectRoot)) {
      nextWorkspaces[id] = { ...workspace, path: targetProjectRoot };
      changed += 1;
    } else {
      nextWorkspaces[id] = workspace;
    }
  }
  if (!changed) return 0;
  writeFileAtomicSync(filePath, `${JSON.stringify({ ...document, tables: { ...tables, workspaces: nextWorkspaces } }, null, 2)}\n`, "Agent Core 工作区索引");
  return changed;
}

/**
 * Rebinds Agent Core's durable history from one already-moved Suzu contact workspace
 * to its new absolute path.  This is deliberately synchronous: it runs only
 * during explicit directory selection or application-start data migration,
 * when no Agent Core child process has been started yet.
 */
export function relocateAgentWorkspaceStorageSync({ runtimeHome, sourceProjectRoot, targetProjectRoot } = {}) {
  const home = requiredAbsoluteDirectory(runtimeHome, "Agent Core 运行时目录");
  const source = requiredAbsoluteDirectory(sourceProjectRoot, "原联系人工作目录");
  const target = requiredAbsoluteDirectory(targetProjectRoot, "新联系人工作目录");
  if (samePath(source, target)) {
    return Object.freeze({ headersUpdated: 0, sessionDirectoriesRelocated: 0, workspaceReferencesUpdated: 0 });
  }

  const sessionsRoot = path.join(home, "sessions");
  const sourceProjectDirectory = containedChild(sessionsRoot, path.join(sessionsRoot, agentProjectDirectoryName(source)), "原 Agent 项目目录");
  const targetProjectDirectory = containedChild(sessionsRoot, path.join(sessionsRoot, agentProjectDirectoryName(target)), "新 Agent 项目目录");
  const sourceDirectory = ordinaryDirectorySync(sourceProjectDirectory, "原 Agent Core 项目目录");
  let headersUpdated = 0;
  let sessionDirectoriesRelocated = 0;

  if (sourceDirectory) {
    let entries;
    try {
      entries = fsSync.readdirSync(sourceDirectory, { withFileTypes: true });
    } catch (error) {
      throw new AgentSessionStorageError("无法读取原 Agent Core 项目目录。", { cause: error, code: "STORAGE_DIRECTORY_INVALID" });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourceSessionDirectory = containedChild(sourceDirectory, path.join(sourceDirectory, entry.name), "原 Agent Core 会话目录");
      if (!ordinaryDirectorySync(sourceSessionDirectory, "原 Agent Core 会话目录")) continue;
      const plainPath = path.join(sourceSessionDirectory, "session.jsonl");
      const zstdPath = path.join(sourceSessionDirectory, "session.jsonl.zstd");
      const hasPlain = ordinaryFileSync(plainPath, "Agent Core JSONL 会话文件");
      const hasZstd = ordinaryFileSync(zstdPath, "Agent Core Zstandard 会话文件");
      if (hasPlain && hasZstd) {
        throw new AgentSessionStorageError("同一 Agent Core 会话同时存在两种日志编码。", { code: "SESSION_ARTIFACT_INVALID" });
      }
      if (!hasPlain && !hasZstd) continue;
      let targetSessionDirectory = "";
      if (!samePath(sourceProjectDirectory, targetProjectDirectory)) {
        fsSync.mkdirSync(targetProjectDirectory, { recursive: true });
        if (!ordinaryDirectorySync(targetProjectDirectory, "新 Agent Core 项目目录")) {
          throw new AgentSessionStorageError("无法创建新 Agent Core 项目目录。", { code: "STORAGE_DIRECTORY_INVALID" });
        }
        targetSessionDirectory = containedChild(targetProjectDirectory, path.join(targetProjectDirectory, entry.name), "新 Agent Core 会话目录");
        if (fsSync.existsSync(targetSessionDirectory)) {
          throw new AgentSessionStorageError("新 Agent Core 项目目录中已存在同名会话，已拒绝覆盖。", { code: "SESSION_RELOCATION_CONFLICT" });
        }
      }
      const updated = rewriteSessionHeaderSync(hasZstd ? zstdPath : plainPath, {
        sourceProjectRoot: source,
        targetProjectRoot: target,
        zstd: hasZstd,
      });
      if (!updated) continue;
      headersUpdated += 1;
      if (!samePath(sourceProjectDirectory, targetProjectDirectory)) {
        try {
          fsSync.renameSync(sourceSessionDirectory, targetSessionDirectory);
        } catch (error) {
          throw new AgentSessionStorageError("无法移动 Agent Core 会话目录。", { cause: error, code: "SESSION_RELOCATION_FAILED" });
        }
        sessionDirectoriesRelocated += 1;
      }
    }
  }

  const workspaceReferencesUpdated = relocateWorkspaceIndexSync(home, {
    sourceProjectRoot: source,
    targetProjectRoot: target,
  });
  return Object.freeze({ headersUpdated, sessionDirectoriesRelocated, workspaceReferencesUpdated });
}

function attachmentDigest(value) {
  const match = ATTACHMENT_ID_PATTERN.exec(clean(value));
  return match?.[1] || "";
}

function attachmentSet(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => attachmentDigest(value))
    .filter(Boolean));
}

/** Collects native Agent Core image object IDs from durable-history event objects. */
export function collectAgentImageAttachmentIds(events) {
  const values = new Set();
  const pending = Array.isArray(events) ? [...events] : [];
  const visited = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (value && typeof value === "object") {
      if (visited.has(value)) continue;
      visited.add(value);
      if (Array.isArray(value)) {
        pending.push(...value);
        continue;
      }
      const source = plainObject(value);
      const direct = attachmentDigest(source.attachmentId);
      if (direct) values.add(`sha256:${direct}`);
      const attachment = plainObject(source.attachment);
      const nested = attachmentDigest(attachment.attachmentId);
      if (nested) values.add(`sha256:${nested}`);
      for (const nestedValue of Object.values(source)) pending.push(nestedValue);
      continue;
    }
    const inline = attachmentDigest(value);
    if (inline) values.add(`sha256:${inline}`);
  }
  return Object.freeze([...values].sort());
}

function assertFsContract(fsOps) {
  for (const method of ["lstat", "mkdir", "readFile", "rename", "rm", "writeFile"]) {
    if (typeof fsOps?.[method] !== "function") {
      throw new AgentSessionStorageError(`Agent Core 会话清理缺少文件接口 ${method}()。`, { code: "FILESYSTEM_CONTRACT_INVALID" });
    }
  }
}

async function existingOrdinaryFile(fsOps, filePath, label) {
  try {
    const stat = await fsOps.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AgentSessionStorageError(`${label}不是可安全修改的普通文件。`, { code: "UNSAFE_STORAGE_FILE" });
    }
    return true;
  } catch (error) {
    if (clean(error?.code) === "ENOENT") return false;
    throw error;
  }
}

async function existingOrdinaryDirectory(fsOps, directory, label) {
  try {
    const stat = await fsOps.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AgentSessionStorageError(`${label}不是可安全删除的普通目录。`, { code: "UNSAFE_STORAGE_DIRECTORY" });
    }
    return true;
  } catch (error) {
    if (clean(error?.code) === "ENOENT") return false;
    throw error;
  }
}

async function readStorageUnit(fsOps, filePath, expectedName) {
  if (!(await existingOrdinaryFile(fsOps, filePath, `Agent Core 存储单元 ${expectedName}`))) return null;
  let document;
  try {
    document = JSON.parse(await fsOps.readFile(filePath, "utf8"));
  } catch (error) {
    throw new AgentSessionStorageError(`无法读取 Agent Core 存储单元 ${expectedName}。`, { cause: error, code: "STORAGE_UNIT_INVALID" });
  }
  const source = plainObject(document);
  const unit = plainObject(source.unit);
  const tables = source.tables;
  if (unit.name !== expectedName || !Number.isInteger(unit.version) || !tables || typeof tables !== "object" || Array.isArray(tables)) {
    throw new AgentSessionStorageError(`Agent Core 存储单元 ${expectedName} 的格式不受当前版本支持。`, { code: "STORAGE_UNIT_INVALID" });
  }
  return source;
}

async function writeStorageUnitAtomic(fsOps, filePath, document) {
  const parent = path.dirname(filePath);
  await fsOps.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(filePath)}.suzu-delete-${randomUUID()}.tmp`);
  try {
    await fsOps.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fsOps.rename(temporary, filePath);
  } catch (error) {
    await fsOps.rm(temporary, { force: true }).catch(() => undefined);
    throw new AgentSessionStorageError("无法原子更新 Agent Core 会话索引。", { cause: error, code: "STORAGE_UNIT_WRITE_FAILED" });
  }
}

function eraseProjectionCheckpoint(document, sessionId) {
  const tables = plainObject(document.tables);
  const sessions = plainObject(tables.sessions);
  if (!Object.hasOwn(sessions, sessionId)) return false;
  delete sessions[sessionId];
  document.tables = { ...tables, sessions };
  return true;
}

function eraseWorkspaceReferences(document, { projectRoot, sessionId }) {
  const tables = plainObject(document.tables);
  const workspaces = plainObject(tables.workspaces);
  const deletedWorkspaceIds = new Set();
  let changed = false;
  for (const [workspaceId, value] of Object.entries(workspaces)) {
    const workspace = plainObject(value);
    if (clean(workspace.path) && samePath(workspace.path, projectRoot)) {
      delete workspaces[workspaceId];
      deletedWorkspaceIds.add(workspaceId);
      changed = true;
      continue;
    }
    if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue;
    workspaces[workspaceId] = {
      ...workspace,
      sessionIds: workspace.sessionIds.filter((candidate) => candidate !== sessionId),
    };
    changed = true;
  }
  const global = plainObject(document.global);
  const archived = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [];
  const workspaceIds = Array.isArray(global.workspaceIds) ? global.workspaceIds : [];
  const nextArchived = archived.filter((candidate) => candidate !== sessionId);
  const nextWorkspaceIds = workspaceIds.filter((candidate) => !deletedWorkspaceIds.has(candidate));
  if (nextArchived.length !== archived.length || nextWorkspaceIds.length !== workspaceIds.length) changed = true;
  if (!changed) return false;
  document.tables = { ...tables, workspaces };
  document.global = {
    ...global,
    ...(Array.isArray(global.archivedSessionIds) ? { archivedSessionIds: nextArchived } : {}),
    ...(Array.isArray(global.workspaceIds) ? { workspaceIds: nextWorkspaceIds } : {}),
  };
  return true;
}

async function deleteAttachmentObject(fsOps, root, digest) {
  const bucket = containedChild(root, path.join(root, digest.slice(0, 2)), "Agent Core 附件桶目录");
  const target = containedChild(bucket, path.join(bucket, digest), "Agent Core 附件对象");
  let stat;
  try {
    stat = await fsOps.lstat(target);
  } catch (error) {
    if (clean(error?.code) === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AgentSessionStorageError("Agent Core 附件对象不是可安全删除的普通文件。", { code: "UNSAFE_ATTACHMENT_OBJECT" });
  }
  await fsOps.rm(target, { force: false, maxRetries: 2, retryDelay: 100 });
  return true;
}

/**
 * Erases the known, contact-scoped Agent Core artifacts after its owning child
 * process has stopped.  It intentionally leaves shared attachment blobs that
 * another current contact still references; unshared native-image objects are
 * removed with the session itself.
 */
export async function deleteAgentSessionStorage({
  runtimeHome,
  projectRoot,
  sessionId,
  imageAttachmentIds = [],
  protectedImageAttachmentIds = [],
  fsOps = fs,
} = {}) {
  assertFsContract(fsOps);
  const paths = resolveAgentSessionStoragePaths({ runtimeHome, projectRoot, sessionId });
  const projection = await readStorageUnit(fsOps, paths.sessionProjectionCacheFile, "session_projcache");
  const workspace = await readStorageUnit(fsOps, paths.workspaceFile, "workspace");
  const projectionUpdated = projection ? eraseProjectionCheckpoint(projection, paths.sessionId) : false;
  const workspaceUpdated = workspace ? eraseWorkspaceReferences(workspace, {
    projectRoot: requiredAbsoluteDirectory(projectRoot, "联系人工作目录"),
    sessionId: paths.sessionId,
  }) : false;
  // Update the small indexes before the log directory. If an index cannot be
  // validated, contact deletion aborts without first making the durable log
  // disappear behind a stale registry entry.
  if (projectionUpdated) await writeStorageUnitAtomic(fsOps, paths.sessionProjectionCacheFile, projection);
  if (workspaceUpdated) await writeStorageUnitAtomic(fsOps, paths.workspaceFile, workspace);

  const sessionDirectoryPresent = await existingOrdinaryDirectory(fsOps, paths.sessionDirectory, "Agent Core 会话目录");
  if (sessionDirectoryPresent) {
    await fsOps.rm(paths.sessionDirectory, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
  }

  const imageIds = attachmentSet(imageAttachmentIds);
  const protectedIds = attachmentSet(protectedImageAttachmentIds);
  let attachmentObjectsRemoved = 0;
  let attachmentObjectsRetained = 0;
  for (const digest of imageIds) {
    if (protectedIds.has(digest)) {
      attachmentObjectsRetained += 1;
      continue;
    }
    if (await deleteAttachmentObject(fsOps, paths.attachmentObjectsRoot, digest)) attachmentObjectsRemoved += 1;
  }

  return Object.freeze({
    attachmentObjectsRemoved,
    attachmentObjectsRetained,
    projectionCacheUpdated: projectionUpdated,
    sessionDirectoryRemoved: sessionDirectoryPresent,
    sessionDirectory: paths.sessionDirectory,
    workspaceIndexUpdated: workspaceUpdated,
  });
}
