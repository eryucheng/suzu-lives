import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SUZU_GLOBAL_INSTRUCTIONS_FILE = "SUZU.md";
export const SUZU_AGENT_GLOBAL_INSTRUCTIONS_BRIDGE_FILE = "AGENTS.md";
export const DEFAULT_SUZU_GLOBAL_INSTRUCTIONS = `# Suzu 全局设定

你是 Suzu，一个温柔、真诚、尊重边界的个人 AI 陪伴。

- 自然地和人交谈；不知道、做不到或不确定时要坦诚说明。
- 关心对方的感受、意愿、隐私和自主性，不操纵、不羞辱，也不假装拥有现实世界中的能力。
- 陪伴优先于炫技。先理解当前的人和情境，再给出合适、简洁的回应。
- 每个联系人目录中的 SUZU.md 记录该段关系和专属偏好；更深目录中的 SUZU.md 可以补充更具体的情境。
`;

const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024;

export class SuzuInstructionBridgeError extends Error {
  constructor(message, { cause, code = "SUZU_INSTRUCTION_BRIDGE_ERROR", details = {} } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SuzuInstructionBridgeError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function absoluteDirectory(value, label) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) {
    throw new SuzuInstructionBridgeError(`${label}必须是绝对目录。`, { code: "INVALID_DIRECTORY" });
  }
  return path.resolve(source);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function containedPath(root, name, label) {
  const target = path.resolve(root, name);
  if (!inside(root, target)) {
    throw new SuzuInstructionBridgeError(`${label}超出了受管目录。`, { code: "PATH_ESCAPE" });
  }
  return target;
}

function missing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function maxBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024) {
    throw new SuzuInstructionBridgeError("SUZU.md 的单文件上限必须是 1 到 1048576 字节。", { code: "INVALID_MAX_BYTES" });
  }
  return value;
}

function assertFilesystem(fsOps) {
  for (const method of ["lstat", "mkdir", "readFile", "rename", "rm", "writeFile"]) {
    if (typeof fsOps?.[method] !== "function") {
      throw new SuzuInstructionBridgeError(`指令桥接文件系统缺少 ${method}()。`, { code: "FILESYSTEM_CONTRACT_INVALID" });
    }
  }
  return fsOps;
}

async function safeRegularFile(fsOps, filePath, label) {
  try {
    const stat = await fsOps.lstat(filePath);
    if (stat.isSymbolicLink?.()) {
      throw new SuzuInstructionBridgeError(`${label}不能是符号链接。`, {
        code: "UNSAFE_SYMBOLIC_LINK",
        details: { path: filePath },
      });
    }
    if (!stat.isFile?.()) {
      throw new SuzuInstructionBridgeError(`${label}必须是普通文件。`, {
        code: "UNSAFE_FILE_TYPE",
        details: { path: filePath },
      });
    }
    return stat;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function atomicWrite(fsOps, target, content) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fsOps.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await fsOps.rename(temporary, target);
  } catch (error) {
    await fsOps.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sourceSize(_stat, content) {
  // The source can change between lstat() and readFile().  Always measure the
  // content we are about to mirror, rather than trusting the earlier snapshot.
  return Buffer.byteLength(content, "utf8");
}

/**
 * Maps Suzu's user-facing global SUZU.md onto the selected execution kernel's fixed global AGENTS.md
 * location.  The bridge file is private implementation data: users edit only
 * SUZU.md, while the selected execution kernel's maintained agent-instructions plugin performs the
 * actual model-context injection and directory precedence resolution.
 */
export function createSuzuInstructionBridge({
  dataRoot,
  runtimeHome,
  fsOps = fs,
  initialContent = DEFAULT_SUZU_GLOBAL_INSTRUCTIONS,
  maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
} = {}) {
  const sourceRoot = absoluteDirectory(dataRoot, "Suzu 软件数据目录");
  const coreHome = absoluteDirectory(runtimeHome, "Suzu Agent Core 数据目录");
  const fileSystem = assertFilesystem(fsOps);
  const maximum = maxBytes(maxSourceBytes);
  const defaultContent = String(initialContent ?? "");
  const globalPath = containedPath(sourceRoot, SUZU_GLOBAL_INSTRUCTIONS_FILE, "全局 SUZU.md");
  const bridgePath = containedPath(coreHome, SUZU_AGENT_GLOBAL_INSTRUCTIONS_BRIDGE_FILE, "Suzu Agent Core 指令桥接文件");

  const sync = async () => {
    await fileSystem.mkdir(sourceRoot, { recursive: true });
    let sourceStat = await safeRegularFile(fileSystem, globalPath, "全局 SUZU.md");
    let createdGlobal = false;
    if (!sourceStat) {
      await atomicWrite(fileSystem, globalPath, defaultContent);
      sourceStat = await safeRegularFile(fileSystem, globalPath, "全局 SUZU.md");
      createdGlobal = true;
    }
    if (sourceStat?.size > maximum) {
      throw new SuzuInstructionBridgeError(`全局 SUZU.md 超过 ${maximum.toLocaleString("zh-CN")} 字节上限。`, {
        code: "SOURCE_TOO_LARGE",
        details: { bytes: sourceStat.size, maxSourceBytes: maximum, path: globalPath },
      });
    }
    const content = await fileSystem.readFile(globalPath, "utf8");
    const bytes = sourceSize(sourceStat, content);
    if (bytes > maximum) {
      throw new SuzuInstructionBridgeError(`全局 SUZU.md 超过 ${maximum.toLocaleString("zh-CN")} 字节上限。`, {
        code: "SOURCE_TOO_LARGE",
        details: { bytes, maxSourceBytes: maximum, path: globalPath },
      });
    }

    await fileSystem.mkdir(coreHome, { recursive: true });
    const bridgeStat = await safeRegularFile(fileSystem, bridgePath, "Suzu Agent Core 指令桥接文件");
    const previous = bridgeStat ? await fileSystem.readFile(bridgePath, "utf8") : null;
    const changed = previous !== content;
    if (changed) await atomicWrite(fileSystem, bridgePath, content);
    return Object.freeze({
      bridgePath,
      bytes,
      changed,
      createdGlobal,
      globalPath,
    });
  };

  return Object.freeze({
    paths: Object.freeze({ bridgePath, globalPath }),
    sync,
  });
}
