import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentRuntime } from "@suzu-lives/agent-runtime";
import {
  SuzuAgentRuntimeError,
  createSuzuAgentRuntimeDriver,
  createSuzuAgentCoreSupervisor,
} from "@suzu-lives/suzu-agent-runtime";
import {
  SUZU_COMPANION_AGENT_PRESET,
  createSuzuAgentComposition,
} from "@suzu-lives/suzu-agent-composition";
import { ensureSuzuAgentExternalCapabilitiesPatch } from "./agent-external-capabilities.mjs";
import { deleteAgentSessionStorage } from "./agent-session-storage.mjs";
import { createSuzuInstructionBridge } from "./suzu-instruction-bridge.mjs";

export { SUZU_COMPANION_AGENT_PRESET };
export const SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET = "suzu-software-assistant";
export const SUZU_COMPANION_PERMISSION_MODE = "danger-full-access";

const DEFAULT_SUZU_AGENT_COMPOSITION = createSuzuAgentComposition();

const SERVICE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SUZU_COMPANION_PRESET_ASSET_DIRECTORY = path.join(
  SERVICE_DIRECTORY,
  "..",
  "assets",
  "agent-presets",
  SUZU_COMPANION_AGENT_PRESET,
);
const SUZU_COMPANION_PRESET_FILES = ["agent.cordis.yml", "preset.yml"];
const SUZU_SOFTWARE_ASSISTANT_PRESET_ASSET_DIRECTORY = path.join(
  SERVICE_DIRECTORY,
  "..",
  "assets",
  "agent-presets",
  SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET,
);
const SUZU_SOFTWARE_ASSISTANT_PRESET_FILES = ["agent.cordis.yml", "preset.yml"];
export class SuzuAgentRuntimeServiceError extends Error {
  constructor(message, { cause, code = "SUZU_AGENT_RUNTIME_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SuzuAgentRuntimeServiceError";
    this.code = code;
  }
}


function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredAbsoluteDirectory(value, label) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) {
    throw new SuzuAgentRuntimeServiceError(`${label}必须是绝对目录。`, { code: "INVALID_DIRECTORY" });
  }
  return path.resolve(source);
}

function errorMessage(error, fallback) {
  return clean(error?.message || error) || fallback;
}

function alreadyExists(error) {
  return clean(error?.code).toUpperCase() === "EEXIST";
}

function notFound(error) {
  return clean(error?.code).toUpperCase() === "ENOENT";
}

/**
 * Seeds Suzu's product-owned companion composition only when it is missing.
 * Existing files are always left untouched: cross-version migration is an
 * explicit one-time product workflow, never an implicit runtime side effect.
 */
export async function ensureSuzuCompanionAgentPreset({
  runtimeHome,
  assetDirectory = SUZU_COMPANION_PRESET_ASSET_DIRECTORY,
  fsOps = fs,
} = {}) {
  const home = requiredAbsoluteDirectory(runtimeHome, "Suzu Agent Core 数据目录");
  const sourceDirectory = requiredAbsoluteDirectory(assetDirectory, "Suzu 陪伴 preset 资源目录");
  if (!fsOps?.mkdir || !fsOps?.readFile || !fsOps?.writeFile) {
    throw new SuzuAgentRuntimeServiceError("Suzu 陪伴 preset 文件接口无效。", { code: "PRESET_FILESYSTEM_INVALID" });
  }
  const contents = await Promise.all(SUZU_COMPANION_PRESET_FILES.map(async (fileName) => {
    try {
      return [fileName, await fsOps.readFile(path.join(sourceDirectory, fileName), "utf8")];
    } catch (error) {
      throw new SuzuAgentRuntimeServiceError(
        `无法读取 Suzu 陪伴 preset 资源：${fileName}。`,
        { cause: error, code: "PRESET_ASSET_MISSING" },
      );
    }
  }));
  const targetDirectory = path.join(home, ".agent-presets", SUZU_COMPANION_AGENT_PRESET);
  await fsOps.mkdir(targetDirectory, { recursive: true });
  const existing = await Promise.all(SUZU_COMPANION_PRESET_FILES.map(async (fileName) => {
    try {
      return [fileName, await fsOps.readFile(path.join(targetDirectory, fileName), "utf8")];
    } catch (error) {
      if (notFound(error)) return [fileName, null];
      throw new SuzuAgentRuntimeServiceError(
        `无法读取已安装的 Suzu 陪伴 preset：${fileName}。`,
        { cause: error, code: "PRESET_READ_FAILED" },
      );
    }
  }));
  const existingByFile = new Map(existing);
  let created = false;
  let updated = false;
  for (const [fileName, content] of contents) {
    const installed = existingByFile.get(fileName);
    if (installed !== null) continue;
    try {
      await fsOps.writeFile(
        path.join(targetDirectory, fileName),
        content,
        { encoding: "utf8", flag: "wx" },
      );
      created = true;
    } catch (error) {
      if (installed === null && alreadyExists(error)) continue;
      throw new SuzuAgentRuntimeServiceError(
        `无法安装 Suzu 陪伴 preset：${fileName}。`,
        { cause: error, code: "PRESET_INSTALL_FAILED" },
      );
    }
  }
  return Object.freeze({
    agentPreset: SUZU_COMPANION_AGENT_PRESET,
    created,
    updated,
    directory: targetDirectory,
  });
}

function unwrapAgentCoreResponse(response, operation) {
  const result = plainObject(response).result;
  if (result?.ok === true) return plainObject(result.value);
  const error = plainObject(result?.error);
  throw new SuzuAgentRuntimeServiceError(
    clean(error.message) || `Suzu Agent Core 拒绝了${operation}。`,
    { code: clean(error.code) || "AGENT_CORE_RPC_REJECTED" },
  );
}

// Keep the product-side history contract stable even when Agent Core changes
// its wire shape.  Core currently returns raw event records in `events`; all
// Suzu consumers receive `{ event: rawEvent }` entries instead.  That makes
// pagination, compaction, attachment cleanup and the conversation renderer
// share one invariant rather than each having to guess the transport shape.
function normalizeAgentCoreHistory(value) {
  const source = plainObject(value);
  const events = Array.isArray(source.events) ? source.events : [];
  return {
    ...source,
    events: events.map((entry) => {
      const sourceEntry = plainObject(entry);
      const wrapped = plainObject(sourceEntry.event);
      return { event: Object.keys(wrapped).length ? wrapped : sourceEntry };
    }),
  };
}

/**
 * Resolves product-owned locations before Suzu Agent Core starts. Its durable
 * data migrates with Suzu's data root; its process-local scratch/cache directory
 * deliberately defaults to D:\Temp on Windows so a normal chat turn never
 * silently falls back to the system drive. The remaining profile-looking
 * paths are also product-owned: an Electron host can be launched by a sandbox
 * with an unusable USERPROFILE (for example, "\\\\?"), and the selected
 * executor as well as its modules can consult the normal Node profile environment.
 */
export function resolveSuzuAgentRuntimePaths({
  dataRoot,
  temporaryDirectory = "",
} = {}) {
  const root = requiredAbsoluteDirectory(dataRoot, "Suzu 软件数据目录");
  const agentRuntimeRoot = path.join(root, "agent-runtime");
  const processHome = path.join(agentRuntimeRoot, "core-process-home");
  const explicitTemporary = clean(temporaryDirectory);
  const tempRoot = explicitTemporary
    ? requiredAbsoluteDirectory(explicitTemporary, "Suzu Agent Core 临时目录")
    : process.platform === "win32"
      ? path.join("D:\\Temp", "suzu-lives-agent-core")
      : path.join(root, "temporary", "agent-core");
  return Object.freeze({
    runtimeHome: path.join(agentRuntimeRoot, "core"),
    temporaryDirectory: tempRoot,
    // D:\Temp is the normal Windows choice. A Windows Sandbox may not expose
    // a D: volume at all, so startup can fall back to durable application data
    // rather than failing before Agent Core has a chance to start.
    fallbackTemporaryDirectory: path.join(root, "temporary", "agent-core"),
    // Do not let the embedded process inherit a host's profile paths. These
    // entries are passed explicitly below, before the selected executor can resolve
    // a user home / shared Agent root on its own.
    coreProcessHome: processHome,
    coreAgentsHome: path.join(agentRuntimeRoot, "core-agents"),
    coreAppData: path.join(processHome, "AppData", "Roaming"),
    coreLocalAppData: path.join(processHome, "AppData", "Local"),
  });
}

/**
 * The product-use assistant is a fixed internal composition rather than a
 * user-editable companion preset.  Refresh its two tiny files at startup so
 * an app update cannot leave an old tool contract or a stale
 * compaction prompt inside the managed Agent Core home.
 */
export async function ensureSuzuSoftwareAssistantAgentPreset({
  runtimeHome,
  assetDirectory = SUZU_SOFTWARE_ASSISTANT_PRESET_ASSET_DIRECTORY,
  fsOps = fs,
} = {}) {
  const home = requiredAbsoluteDirectory(runtimeHome, "Suzu Agent Core 数据目录");
  const sourceDirectory = requiredAbsoluteDirectory(assetDirectory, "Suzu 软件助手 preset 资源目录");
  if (!fsOps?.mkdir || !fsOps?.readFile || !fsOps?.writeFile) {
    throw new SuzuAgentRuntimeServiceError("Suzu 软件助手 preset 文件接口无效。", { code: "PRESET_FILESYSTEM_INVALID" });
  }
  const contents = await Promise.all(SUZU_SOFTWARE_ASSISTANT_PRESET_FILES.map(async (fileName) => {
    try {
      return [fileName, await fsOps.readFile(path.join(sourceDirectory, fileName), "utf8")];
    } catch (error) {
      throw new SuzuAgentRuntimeServiceError(
        `无法读取 Suzu 软件助手 preset 资源：${fileName}。`,
        { cause: error, code: "PRESET_ASSET_MISSING" },
      );
    }
  }));
  const targetDirectory = path.join(home, ".agent-presets", SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET);
  await fsOps.mkdir(targetDirectory, { recursive: true });
  let created = false;
  let updated = false;
  for (const [fileName, content] of contents) {
    const target = path.join(targetDirectory, fileName);
    let existing = null;
    try {
      existing = await fsOps.readFile(target, "utf8");
    } catch (error) {
      if (!notFound(error)) {
        throw new SuzuAgentRuntimeServiceError(
          `无法读取已安装的 Suzu 软件助手 preset：${fileName}。`,
          { cause: error, code: "PRESET_READ_FAILED" },
        );
      }
    }
    if (existing === content) continue;
    try {
      await fsOps.writeFile(target, content, "utf8");
    } catch (error) {
      throw new SuzuAgentRuntimeServiceError(
        `无法安装 Suzu 软件助手 preset：${fileName}。`,
        { cause: error, code: "PRESET_INSTALL_FAILED" },
      );
    }
    if (existing === null) created = true;
    else updated = true;
  }
  return Object.freeze({
    agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET,
    created,
    updated,
    directory: targetDirectory,
  });
}

/**
 * Owns Suzu's private Node IPC Agent Core child shared by the conversation
 * reader and chat adapter. It opens neither a browser interface nor a network
 * control plane. The public `history()` path reads the selected execution
 * kernel's session API rather than private storage files.
 */
export function createSuzuAgentRuntime({
  dataRoot,
  temporaryDirectory = "",
  workspaceDirectory,
  fsOps = fs,
  defaultAgentPreset = SUZU_COMPANION_AGENT_PRESET,
  agentAdapter = DEFAULT_SUZU_AGENT_COMPOSITION,
  presetAssetDirectory = SUZU_COMPANION_PRESET_ASSET_DIRECTORY,
  ensureCompanionPreset = ensureSuzuCompanionAgentPreset,
  softwareAssistantPresetAssetDirectory = SUZU_SOFTWARE_ASSISTANT_PRESET_ASSET_DIRECTORY,
  ensureSoftwareAssistantPreset = ensureSuzuSoftwareAssistantAgentPreset,
  createInstructionBridge = createSuzuInstructionBridge,
  createSupervisor = createSuzuAgentCoreSupervisor,
  createDriver = createSuzuAgentRuntimeDriver,
  createRuntimeFacade = createAgentRuntime,
  deleteSessionStorage = deleteAgentSessionStorage,
  ensureExternalCapabilitiesPatch = ensureSuzuAgentExternalCapabilitiesPatch,
} = {}) {
  const storage = resolveSuzuAgentRuntimePaths({ dataRoot, temporaryDirectory });
  const usesDefaultTemporaryDirectory = !clean(temporaryDirectory);
  const workspace = requiredAbsoluteDirectory(workspaceDirectory, "Suzu Agent 工作目录");
  let companionAgentBinding;
  try {
    companionAgentBinding = agentAdapter?.resolve?.();
  } catch (error) {
    throw new SuzuAgentRuntimeServiceError(
      `无法解析 Suzu 陪伴 Agent 定义：${errorMessage(error, "未知错误。")}`,
      { cause: error, code: error?.code || "AGENT_DEFINITION_RESOLVE_FAILED" },
    );
  }
  const companionPreset = clean(companionAgentBinding?.agentPreset);
  if (!companionPreset || clean(defaultAgentPreset) !== companionPreset || typeof ensureCompanionPreset !== "function" || typeof ensureSoftwareAssistantPreset !== "function" || typeof ensureExternalCapabilitiesPatch !== "function" || typeof createInstructionBridge !== "function" || !fsOps?.mkdir || typeof createSupervisor !== "function" || typeof createDriver !== "function" || typeof createRuntimeFacade !== "function" || typeof deleteSessionStorage !== "function") {
    throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时依赖无效。", { code: "RUNTIME_CONTRACT_INVALID" });
  }
  let instructionBridge;
  try {
    instructionBridge = createInstructionBridge({
      dataRoot,
      runtimeHome: storage.runtimeHome,
      fsOps,
    });
  } catch (error) {
    throw new SuzuAgentRuntimeServiceError(
      `无法准备 Suzu 指令桥接：${errorMessage(error, "初始化失败。")}`,
      { cause: error, code: error?.code || "INSTRUCTION_BRIDGE_INIT_FAILED" },
    );
  }
  if (typeof instructionBridge?.sync !== "function") {
    throw new SuzuAgentRuntimeServiceError("Suzu 指令桥接接口无效。", { code: "INSTRUCTION_BRIDGE_INVALID" });
  }

  const listeners = new Set();
  let supervisor = null;
  let driver = null;
  let runtime = null;
  let unsubscribeRuntime = null;
  let unsubscribeSupervisorLifecycle = null;
  let startTask = null;
  let closeTask = null;
  let closed = false;
  let instructionSyncTask = null;
  let lastInstructionSync = null;
  let externalCapabilitiesPatchFile = "";
  let activeTemporaryDirectory = storage.temporaryDirectory;

  const publish = (event) => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* A chat/UI listener cannot own the process. */ }
    }
  };

  const disposeFacade = async () => {
    try { unsubscribeRuntime?.(); } catch { /* Best effort before closing the facade. */ }
    unsubscribeRuntime = null;
    const currentRuntime = runtime;
    runtime = null;
    driver = null;
    if (currentRuntime?.closeRuntime) await currentRuntime.closeRuntime();
  };

  /**
   * The selected upstream instruction module expects AGENTS.md under its own
   * data root. Keep that implementation detail synchronized from Suzu's
   * user-facing SUZU.md before every new turn, rather than placing hidden text
   * into user messages.
   */
  const prepareInstructions = async () => {
    if (instructionSyncTask) return instructionSyncTask;
    instructionSyncTask = (async () => {
      try {
        const result = await instructionBridge.sync();
        lastInstructionSync = result;
        return result;
      } catch (error) {
        throw new SuzuAgentRuntimeServiceError(
          `无法同步 Suzu 指令：${errorMessage(error, "未知错误。")}`,
          { cause: error, code: error?.code || "INSTRUCTION_SYNC_FAILED" },
        );
      }
    })().finally(() => { instructionSyncTask = null; });
    return instructionSyncTask;
  };

  const prepareSupervisor = async () => {
    await fsOps.mkdir(storage.runtimeHome, { recursive: true });
    try {
      await fsOps.mkdir(activeTemporaryDirectory, { recursive: true });
    } catch (error) {
      const canUseDataRootFallback = usesDefaultTemporaryDirectory
        && activeTemporaryDirectory === storage.temporaryDirectory
        && activeTemporaryDirectory !== storage.fallbackTemporaryDirectory
        && notFound(error);
      if (!canUseDataRootFallback) throw error;
      activeTemporaryDirectory = storage.fallbackTemporaryDirectory;
      await fsOps.mkdir(activeTemporaryDirectory, { recursive: true });
    }
    await Promise.all([
      storage.coreProcessHome,
      storage.coreAgentsHome,
      storage.coreAppData,
      storage.coreLocalAppData,
    ].map((directory) => fsOps.mkdir(directory, { recursive: true })));
    try {
      await prepareInstructions();
      await Promise.all([
        ensureCompanionPreset({
          runtimeHome: storage.runtimeHome,
          assetDirectory: presetAssetDirectory,
          fsOps,
        }),
        ensureSoftwareAssistantPreset({
          runtimeHome: storage.runtimeHome,
          assetDirectory: softwareAssistantPresetAssetDirectory,
          fsOps,
        }),
      ]);
      const externalCapabilities = await ensureExternalCapabilitiesPatch({
        runtimeHome: storage.runtimeHome,
        fsOps,
      });
      externalCapabilitiesPatchFile = requiredAbsoluteDirectory(externalCapabilities?.patchFile, "Suzu Agent Core 外部能力配置补丁");
    } catch (error) {
      if (error instanceof SuzuAgentRuntimeServiceError) throw error;
      throw new SuzuAgentRuntimeServiceError(
        `无法准备 Suzu Agent Core：${errorMessage(error, "preset 初始化失败。")}`,
        { cause: error, code: error?.code || "PRESET_INSTALL_FAILED" },
      );
    }
    if (!supervisor) {
      supervisor = createSupervisor({
        runtimeHome: storage.runtimeHome,
        temporaryDirectory: activeTemporaryDirectory,
        workspaceDirectory: workspace,
        environment: {
          // Node's homedir() and the selected execution kernel consult these
          // values. Keeping them within the durable Suzu data root prevents a
          // sandbox's malformed profile path from reaching Agent Core.
          SUZU_AGENT_AGENTS_HOME: storage.coreAgentsHome,
          HOME: storage.coreProcessHome,
          USERPROFILE: storage.coreProcessHome,
          APPDATA: storage.coreAppData,
          LOCALAPPDATA: storage.coreLocalAppData,
          SUZU_AGENT_PERMISSION_MODE: SUZU_COMPANION_PERMISSION_MODE,
          SUZU_AGENT_TELEMETRY_DISABLED: "1",
        },
        patchFiles: [externalCapabilitiesPatchFile],
      });
      if (!supervisor?.start || !supervisor?.stop || !supervisor?.status) {
        throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 进程监管器无效。", { code: "SUPERVISOR_CONTRACT_INVALID" });
      }
    }
    if (!unsubscribeSupervisorLifecycle && typeof supervisor.subscribeLifecycle === "function") {
      unsubscribeSupervisorLifecycle = supervisor.subscribeLifecycle((message) => {
        const source = plainObject(message);
        const kind = clean(source.kind);
        if (kind === "request") {
          publish(Object.freeze({
            type: "lifecycle-request",
            requestId: clean(source.requestId),
            lifecycleEvent: clean(source.event),
            data: Object.freeze({ ...plainObject(source.payload) }),
          }));
          return;
        }
        if (kind === "event") {
          publish(Object.freeze({
            type: "lifecycle-event",
            lifecycleEvent: clean(source.event),
            data: Object.freeze({ ...plainObject(source.payload) }),
          }));
        }
      });
    }
    return supervisor;
  };

  const start = async () => {
    if (closed) throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时已经关闭。", { code: "RUNTIME_CLOSED" });
    if (runtime && supervisor?.status?.().state === "ready") return runtime;
    if (startTask) return startTask;
    startTask = (async () => {
      // A previous owned process can have exited after its event-stream
      // failed.  Do not reuse a facade bound to that dead transport.
      if (runtime) await disposeFacade();
      const processSupervisor = await prepareSupervisor();
      let started;
      try {
        started = await processSupervisor.start();
      } catch (error) {
        throw new SuzuAgentRuntimeServiceError(
          `无法启动 Suzu Agent Core：${errorMessage(error, "启动失败。")}`,
          { cause: error, code: error?.code || "AGENT_CORE_START_FAILED" },
        );
      }
      try {
        driver = createDriver({ api: started.api });
        runtime = createRuntimeFacade({ driver });
        unsubscribeRuntime = runtime.subscribe((event) => publish(event));
        return runtime;
      } catch (error) {
        await disposeFacade().catch(() => undefined);
        throw new SuzuAgentRuntimeServiceError(
          `无法建立 Suzu Agent 会话接口：${errorMessage(error, "初始化失败。")}`,
          { cause: error, code: error?.code || "AGENT_RUNTIME_INIT_FAILED" },
        );
      }
    })().finally(() => { startTask = null; });
    return startTask;
  };

  const managedPreset = (presentation = {}) => {
    const requested = clean(plainObject(presentation).agentPreset);
    if (!requested || requested === companionPreset) return companionPreset;
    if (requested === SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET) return requested;
    throw new SuzuAgentRuntimeServiceError("Suzu Agent 会话不能使用未受产品管理的 preset。", { code: "AGENT_PRESET_UNAVAILABLE" });
  };

  const ensureSession = async ({ sessionId, contactId = "", cwd, presentation = {} } = {}) => {
    const facade = await start();
    try {
      return await facade.createSession({
        sessionId,
        contactId,
        cwd,
        presentation: {
          ...plainObject(presentation),
          agentPreset: managedPreset(presentation),
        },
      });
    } catch (error) {
      throw new SuzuAgentRuntimeServiceError(
        `无法打开 Suzu Agent 会话：${errorMessage(error, "未知错误。")}`,
        { cause: error, code: error?.code || "AGENT_SESSION_CREATE_FAILED" },
      );
    }
  };

  const history = async ({ sessionId, contactId = "", cwd, maxMessages = 500, beforeSeq = undefined, presentation = {} } = {}) => {
    const safeLimit = Number.isSafeInteger(maxMessages) && maxMessages > 0
      ? Math.min(maxMessages, 2_000)
      : 500;
    const opened = await ensureSession({ sessionId, contactId, cwd, presentation });
    const coreSessionId = clean(opened?.runtimeSessionId) || clean(sessionId);
    const current = supervisor?.status?.();
    if (!runtime || current?.state !== "ready" || !supervisor) {
      throw new SuzuAgentRuntimeServiceError("Suzu Agent 会话未就绪。", { code: "AGENT_NOT_READY" });
    }
    // `start()` returns the same API while the process is ready.  Calling it
    // here keeps the object reference private and validates the lifecycle.
    const started = await supervisor.start();
    try {
      const request = {
        sessionId: coreSessionId,
        maxMessages: safeLimit,
      };
      if (Number.isSafeInteger(beforeSeq) && beforeSeq >= 0) request.beforeSeq = beforeSeq;
      return normalizeAgentCoreHistory(
        unwrapAgentCoreResponse(await started.api.sessions.history(request), "读取会话历史"),
      );
    } catch (error) {
      if (error instanceof SuzuAgentRuntimeServiceError) throw error;
      throw new SuzuAgentRuntimeServiceError(
        `无法读取 Suzu Agent 会话历史：${errorMessage(error, "未知错误。")}`,
        { cause: error, code: error?.code || "AGENT_HISTORY_FAILED" },
      );
    }
  };

  const runCompaction = async ({ sessionId, contactId = "", cwd, presentation = {} } = {}) => {
    const opened = await ensureSession({ sessionId, contactId, cwd, presentation });
    const coreSessionId = clean(opened?.runtimeSessionId) || clean(sessionId);
    const current = supervisor?.status?.();
    if (!runtime || current?.state !== "ready" || !supervisor) {
      throw new SuzuAgentRuntimeServiceError("Suzu Agent 会话未就绪。", { code: "AGENT_NOT_READY" });
    }
    try {
      // This is the product-owned native maintenance route.  It never creates
      // an ordinary chat turn, so the normal model completion reservation
      // cannot block an overlong history from being compacted.
      const started = await supervisor.start();
      const result = plainObject(unwrapAgentCoreResponse(
        await started.api.sessions.compact({ sessionId: coreSessionId }),
        "压缩会话",
      ));
      if (result.accepted !== true) {
        throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 没有接受压缩请求。", {
          code: "AGENT_COMPACTION_REJECTED",
        });
      }
      if (result.completed !== true) {
        return {
          accepted: true,
          completed: false,
          reason: clean(result.reason) || "NO_COMPACTABLE_HISTORY",
        };
      }
      const compactionId = clean(result.compactionId);
      if (!compactionId) {
        throw new SuzuAgentRuntimeServiceError("Suzu Agent 已完成压缩，但没有返回压缩记录标识。", {
          code: "AGENT_COMPACTION_PROOF_MISSING",
        });
      }
      return {
        accepted: true,
        completed: true,
        compactionId,
        ...(Number.isSafeInteger(result.batchCount) && result.batchCount > 1
          ? { batchCount: result.batchCount }
          : {}),
      };
    } catch (error) {
      if (error instanceof SuzuAgentRuntimeServiceError) throw error;
      throw new SuzuAgentRuntimeServiceError(
        `无法压缩 Suzu Agent 会话：${errorMessage(error, "未知错误。")}`,
        { cause: error, code: error?.code || "AGENT_COMPACTION_FAILED" },
      );
    }
  };

  /**
   * The selected execution kernel exposes no session-delete RPC. Suzu owns this
   * runtime data root and its contact-to-session mapping, so deletion first stops the one owned
   * process (preventing a late write), then removes only the exact persisted
   * session and its known per-session indexes.  The next chat starts a fresh
   * child process on demand.
   */
  const purgeSession = async ({
    sessionId,
    cwd,
    imageAttachmentIds = [],
    protectedImageAttachmentIds = [],
  } = {}) => {
    if (closed) throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时已经关闭。", { code: "RUNTIME_CLOSED" });
    const id = clean(sessionId);
    const projectRoot = clean(cwd);
    if (!id || !projectRoot) {
      throw new SuzuAgentRuntimeServiceError("删除 Suzu Agent 会话需要会话标识和联系人工作目录。", { code: "SESSION_DELETE_INPUT_INVALID" });
    }
    // A deletion can race a first turn beginning to open the child. Wait for
    // that attempt to settle, then always stop the owned process before any
    // durable file is removed. A startup failure leaves no running writer.
    if (startTask) await startTask.catch(() => undefined);
    await disposeFacade().catch(() => undefined);
    if (supervisor) {
      try {
        await supervisor.stop();
      } catch (error) {
        throw new SuzuAgentRuntimeServiceError(
          `无法停止 Suzu Agent 会话进程，未删除任何会话数据：${errorMessage(error, "未知错误。")}`,
          { cause: error, code: error?.code || "AGENT_STOP_FAILED" },
        );
      }
    }
    try {
      return await deleteSessionStorage({
        runtimeHome: storage.runtimeHome,
        projectRoot,
        sessionId: id,
        imageAttachmentIds,
        protectedImageAttachmentIds,
        fsOps,
      });
    } catch (error) {
      if (error instanceof SuzuAgentRuntimeServiceError) throw error;
      throw new SuzuAgentRuntimeServiceError(
        `无法删除 Suzu Agent 会话数据：${errorMessage(error, "未知错误。")}`,
        { cause: error, code: error?.code || "AGENT_SESSION_DELETE_FAILED" },
      );
    }
  };

  /**
   * Agent Core loads MCP composition rows at process start. External
   * capability changes therefore retire only Suzu's owned child; the next
   * chat turn starts it again with the managed overlay, while the contact's
   * native Agent Core history remains intact.
   */
  const reloadExternalCapabilities = async () => {
    if (closed) throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时已经关闭。", { code: "RUNTIME_CLOSED" });
    if (startTask) await startTask.catch(() => undefined);
    await disposeFacade().catch(() => undefined);
    if (supervisor) await supervisor.stop();
    return Object.freeze({ reloaded: true, state: supervisor?.status?.().state || "stopped" });
  };

  return Object.freeze({
    /** Product-internal access to Agent Core's private IPC control plane.
     * It is never forwarded to the renderer; the configuration service uses it
     * for credential and model settings without touching external Agent files. */
    async controlPlane() {
      await start();
      if (!supervisor) {
        throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 控制面未就绪。", { code: "AGENT_NOT_READY" });
      }
      const started = await supervisor.start();
      return started.api;
    },

    async prepareInstructions() {
      if (closed) throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时已经关闭。", { code: "RUNTIME_CLOSED" });
      return prepareInstructions();
    },

    async ensureSession(value) {
      return ensureSession(value);
    },

    async sendTurn(value) {
      const facade = await start();
      return facade.sendTurn(value);
    },

    async cancelTurn(value) {
      const facade = await start();
      return facade.cancelTurn(value);
    },

    async resolveApproval(value) {
      const facade = await start();
      return facade.resolveApproval(value);
    },

    async respondLifecycleRequest({ requestId, result = {} } = {}) {
      if (closed) throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时已经关闭。", { code: "RUNTIME_CLOSED" });
      if (!supervisor?.respondLifecycleRequest) return false;
      return supervisor.respondLifecycleRequest({ requestId, result: plainObject(result) });
    },

    /**
     * Product-internal structured work runs inside the already configured Agent
     * Core child. This deliberately transfers prompts and JSON schemas only: the
     * credential remains in its private credential plane and never becomes an
     * Electron-side OpenAI-compatible connection.
     */
    async generateStructuredMemory({
      contactId = "",
      cwd,
      sessionId,
      input,
      systemPrompt,
      schema,
      schemaName,
      maxOutputTokens,
      timeoutMs,
    } = {}) {
      if (closed) throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时已经关闭。", { code: "RUNTIME_CLOSED" });
      const opened = await ensureSession({ sessionId, contactId, cwd });
      const coreSessionId = clean(opened?.runtimeSessionId) || clean(sessionId);
      if (!coreSessionId || !supervisor?.requestLifecycleCommand) {
        return Object.freeze({ available: false, reason: "structured-generator-unavailable" });
      }
      return supervisor.requestLifecycleCommand({
        event: "StructuredGenerate",
        payload: {
          sessionId: coreSessionId,
          input: String(input ?? ""),
          systemPrompt: String(systemPrompt ?? ""),
          schema: plainObject(schema),
          schemaName: clean(schemaName),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },

    history,

    async runCompaction(value) {
      return runCompaction(value);
    },

    async purgeSession(value) {
      return purgeSession(value);
    },

    async reloadExternalCapabilities() {
      return reloadExternalCapabilities();
    },

    status() {
      return Object.freeze({
        ...(supervisor?.status?.() || { state: "stopped", endpoint: "", pid: null }),
        agentPreset: companionPreset,
        softwareAssistantPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET,
        agentProfileId: companionAgentBinding.profileId,
        agentKey: companionAgentBinding.agentKey,
        permissionMode: SUZU_COMPANION_PERMISSION_MODE,
        globalInstructionsPath: clean(instructionBridge?.paths?.globalPath),
        instructionBridgePath: clean(instructionBridge?.paths?.bridgePath),
        externalCapabilitiesPatchFile,
        instructionBytes: Number(lastInstructionSync?.bytes) || 0,
        runtimeHome: storage.runtimeHome,
        temporaryDirectory: activeTemporaryDirectory,
        coreProcessHome: storage.coreProcessHome,
        coreAgentsHome: storage.coreAgentsHome,
        coreAppData: storage.coreAppData,
        coreLocalAppData: storage.coreLocalAppData,
      });
    },

    subscribe(listener) {
      if (typeof listener !== "function") throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 订阅者无效。", { code: "INVALID_LISTENER" });
      if (closed) throw new SuzuAgentRuntimeServiceError("Suzu Agent Core 会话运行时已经关闭。", { code: "RUNTIME_CLOSED" });
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close() {
      if (closeTask) return closeTask;
      closed = true;
      closeTask = (async () => {
        if (startTask) await startTask.catch(() => undefined);
        await disposeFacade().catch(() => undefined);
        try { unsubscribeSupervisorLifecycle?.(); } catch { /* The owned child is about to stop. */ }
        unsubscribeSupervisorLifecycle = null;
        if (supervisor) await supervisor.stop().catch(() => undefined);
        listeners.clear();
      })();
      return closeTask;
    },
  });
}

export { SuzuAgentRuntimeError };
