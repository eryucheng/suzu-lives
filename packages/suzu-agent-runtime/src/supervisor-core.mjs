import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SuzuAgentRuntimeError } from "./runtime-error.mjs";

import {
  SUZU_AGENT_HOST_IPC_PROTOCOL,
  normalizeSuzuAgentHostIpcMessage,
} from "./agent-host-ipc.mjs";
import {
  SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
  normalizeSuzuAgentLifecycleIpcMessage,
} from "./lifecycle-ipc.mjs";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
// A manual compaction performs one or more durable summarization requests.
// Keep its local IPC request alive long enough for a large legacy session,
// while normal control-plane requests retain the short default timeout.
const MANUAL_COMPACTION_RPC_TIMEOUT_MS = 10 * 60 * 1_000;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function absoluteDirectory(value, label) {
  const candidate = clean(value);
  if (!candidate || !isAbsolute(candidate)) throw new SuzuAgentRuntimeError("INVALID_DIRECTORY", `${label}必须是绝对目录。`);
  const normalized = resolve(candidate);
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new SuzuAgentRuntimeError("DIRECTORY_NOT_FOUND", `${label}不存在或不是目录。`, { details: { path: normalized } });
  }
  return normalized;
}

function absolutePath(value, label) {
  const candidate = clean(value);
  if (!candidate || !isAbsolute(candidate)) throw new SuzuAgentRuntimeError("INVALID_PATH", `${label}必须是绝对路径。`);
  return resolve(candidate);
}

function absoluteFile(value, label) {
  const normalized = absolutePath(value, label);
  if (!existsSync(normalized) || !statSync(normalized).isFile()) {
    throw new SuzuAgentRuntimeError("PATCH_FILE_NOT_FOUND", `${label}不存在或不是文件。`, { details: { path: normalized } });
  }
  return normalized;
}

function patchFileList(value) {
  if (!Array.isArray(value)) throw new SuzuAgentRuntimeError("INVALID_PATCH_FILES", "Agent Core 配置补丁必须是文件数组。 ");
  const seen = new Set();
  const files = [];
  for (const [index, candidate] of value.entries()) {
    const file = absoluteFile(candidate, `Agent Core 配置补丁 #${index + 1}`);
    if (!seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return Object.freeze(files);
}

function normalizePositiveInteger(value, fallback, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate <= 0) throw new SuzuAgentRuntimeError("INVALID_TIMEOUT", `${label}无效。`);
  return candidate;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function deferred() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolvePromiseValue, rejectPromiseValue) => {
    resolvePromise = resolvePromiseValue;
    rejectPromise = rejectPromiseValue;
  });
  return Object.freeze({
    promise,
    resolve(value) {
      if (settled) return false;
      settled = true;
      resolvePromise(value);
      return true;
    },
    reject(error) {
      if (settled) return false;
      settled = true;
      rejectPromise(error);
      return true;
    },
  });
}

function attachOutputTail(stream, limit = 16_000) {
  let tail = "";
  if (!stream || typeof stream.on !== "function") return () => tail;
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => { tail = `${tail}${String(chunk)}`.slice(-limit); });
  return () => tail;
}

function childExitMessage(outcome) {
  if (outcome?.error) return clean(outcome.error.message) || "Suzu Agent Core 子进程无法启动。";
  const signal = clean(outcome?.signal);
  if (signal) return `Suzu Agent Core 进程被 ${signal} 终止。`;
  const code = outcome?.code;
  return `Suzu Agent Core 进程已退出${code === null || code === undefined ? "" : `（代码 ${code}）`}。`;
}

function startupFailure(error, stderr) {
  const lines = clean(stderr).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const diagnostic = (lines.filter((line) => /(?:cannot find|无法|失败|error|suzu-agent-core:)/iu.test(line)).at(-1) || "").slice(0, 800);
  if (!diagnostic) return error instanceof SuzuAgentRuntimeError
    ? error
    : new SuzuAgentRuntimeError("AGENT_CORE_START_FAILED", "Suzu Agent Core 启动失败。", { cause: error });
  return new SuzuAgentRuntimeError(
    clean(error?.code) || "AGENT_CORE_START_FAILED",
    `${clean(error?.message) || "Suzu Agent Core 启动失败。"} 启动诊断：${diagnostic}`,
    { cause: error },
  );
}

function rpcErrorMessage(response) {
  const result = plainObject(response).result;
  return result?.ok === true ? "" : clean(plainObject(result?.error).message) || "Suzu Agent Core 请求被拒绝。";
}

function validRequestId(value) {
  const requestId = clean(value);
  return requestId && requestId.length <= 256 && !/[\r\n\0]/u.test(requestId) ? requestId : "";
}

/** Resolves the private child host that owns Suzu's IPC control plane. */
export function resolveEmbeddedSuzuAgentHost() {
  const host = fileURLToPath(new URL("./embedded-agent-host.mjs", import.meta.url));
  if (!existsSync(host)) throw new SuzuAgentRuntimeError("AGENT_CORE_HOST_MISSING", "嵌入式 Suzu Agent Core Host 文件不存在。", { details: { host } });
  return host;
}

/** Resolves the ESM layout adapter used for selected vendored plugins. */
export function resolveEmbeddedSuzuAgentModuleLoader() {
  const loader = fileURLToPath(new URL("./embedded-module-loader.mjs", import.meta.url));
  if (!existsSync(loader)) throw new SuzuAgentRuntimeError("AGENT_CORE_MODULE_LOADER_MISSING", "嵌入式 Agent Core 模块解析器文件不存在。", { details: { loader } });
  return loader;
}

// Source-level compatibility only: this resolves Suzu's loader and never
// starts or ships an upstream web product.
function createEventStream(record, channel, signal, onOpen) {
  async function* read() {
    const inbox = [];
    let terminal = null;
    let wake = null;
    const notify = () => {
      const listener = wake;
      wake = null;
      listener?.();
    };
    const subscriber = {
      push(frame) { inbox.push(frame); notify(); },
      end(error = null) {
        if (terminal) return;
        terminal = error ? { kind: "error", error } : { kind: "end" };
        notify();
      },
    };
    const abort = () => subscriber.end();
    record.eventSubscribers[channel].add(subscriber);
    signal?.addEventListener?.("abort", abort, { once: true });
    try {
      if (signal?.aborted) return;
      onOpen?.();
      while (true) {
        if (inbox.length) {
          yield inbox.shift();
          continue;
        }
        if (terminal?.kind === "error") throw terminal.error;
        if (terminal?.kind === "end") return;
        await new Promise((resolveWake) => {
          if (inbox.length || terminal || signal?.aborted) resolveWake();
          else wake = resolveWake;
        });
      }
    } finally {
      record.eventSubscribers[channel].delete(subscriber);
      signal?.removeEventListener?.("abort", abort);
    }
  }
  return read();
}

function createAgentCoreApi(record, { requestTimeoutMs = DEFAULT_RPC_TIMEOUT_MS } = {}) {
  let requestSequence = 0;
  const request = (method, payload = {}, timeoutMs = requestTimeoutMs) => {
    const child = record.child;
    if (record.outcome || child.connected === false || typeof child.send !== "function") {
      return Promise.reject(new SuzuAgentRuntimeError("AGENT_CORE_UNAVAILABLE", "Suzu Agent Core 当前不可用。"));
    }
    const timeout = normalizePositiveInteger(timeoutMs, requestTimeoutMs, "Agent Core 请求超时");
    const requestId = `suzu-agent-rpc-${child.pid || "child"}-${Date.now()}-${++requestSequence}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        const pending = record.pendingRequests.get(requestId);
        if (!pending) return;
        record.pendingRequests.delete(requestId);
        rejectRequest(new SuzuAgentRuntimeError("AGENT_CORE_RPC_TIMEOUT", `Suzu Agent Core 请求超时：${method}。`));
      }, timeout);
      timer.unref?.();
      record.pendingRequests.set(requestId, { requestId, resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        // `false` means IPC back-pressure, not a failed send; Node has queued
        // the message.  Only a throw indicates delivery failed.
        child.send({
          protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
          kind: "request",
          requestId,
          method,
          payload: plainObject(payload),
        });
      } catch (error) {
        clearTimeout(timer);
        record.pendingRequests.delete(requestId);
        rejectRequest(new SuzuAgentRuntimeError("AGENT_CORE_IPC_SEND_FAILED", `无法发送 Suzu Agent Core 请求：${method}。`, { cause: error }));
      }
    });
  };
  return Object.freeze({
    host: Object.freeze({ describe: (payload = {}) => request("host.describe", payload) }),
    sessions: Object.freeze({
      create: (payload = {}) => request("sessions.create", payload),
      history: (payload = {}) => request("sessions.history", payload),
      prompt: (payload = {}) => request("sessions.prompt", payload),
      task: (payload = {}) => request("sessions.task", payload),
      compact: (payload = {}) => request("sessions.compact", payload, MANUAL_COMPACTION_RPC_TIMEOUT_MS),
      cancel: (payload = {}) => request("sessions.cancel", payload),
    }),
    settings: Object.freeze({
      describe: (payload = {}) => request("settings.describe", payload),
      mutate: (payload = {}) => request("settings.mutate", payload),
    }),
    credentials: Object.freeze({
      describe: (payload = {}) => request("credentials.describe", payload),
      set: (payload = {}) => request("credentials.set", payload),
    }),
    llm: Object.freeze({
      models: (payload = {}) => request("llm.models", payload),
      discoverModels: (payload = {}) => request("llm.discover-models", payload),
    }),
    respond: (payload = {}) => request("respond", payload),
    events: Object.freeze({
      mux: (_payload = {}, signal, onOpen) => createEventStream(record, "mux", signal, onOpen),
      host: (_payload = {}, signal, onOpen) => createEventStream(record, "host", signal, onOpen),
    }),
  });
}

/**
 * Owns one Suzu Agent Core child process. The product owns the control plane
 * through Node IPC; no browser application, localhost port, HTTP proxy or
 * WebSocket server is started.
 */
export function createSuzuAgentCoreSupervisor({
  runtimeHome,
  temporaryDirectory,
  workspaceDirectory,
  agentHost = resolveEmbeddedSuzuAgentHost(),
  moduleLoader = resolveEmbeddedSuzuAgentModuleLoader(),
  nodeExecutable = process.execPath,
  spawnImpl = nodeSpawn,
  wait = delay,
  startupTimeoutMs = 30_000,
  stopTimeoutMs = 5_000,
  requestTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  environment = {},
  patchFiles = [],
  resourcesPath = process.resourcesPath || "",
} = {}) {
  const home = absolutePath(runtimeHome, "Suzu Agent Core 数据目录");
  const temp = absolutePath(temporaryDirectory, "Suzu Agent Core 临时目录");
  const workspace = absoluteDirectory(workspaceDirectory, "Suzu Agent 工作目录");
  const host = absoluteFile(agentHost, "Suzu Agent Core Host");
  const loader = absoluteFile(moduleLoader, "Suzu Agent Core 模块解析器");
  const executable = absolutePath(nodeExecutable, "Node 可执行文件");
  if (!existsSync(executable)) throw new SuzuAgentRuntimeError("NODE_MISSING", "启动 Suzu Agent Core 所需的 Node 可执行文件不存在。", { details: { executable } });
  if (typeof spawnImpl !== "function" || typeof wait !== "function") {
    throw new SuzuAgentRuntimeError("SUPERVISOR_CONTRACT_INVALID", "Suzu Agent Core 进程监管器依赖无效。 ");
  }
  const startupTimeout = normalizePositiveInteger(startupTimeoutMs, 30_000, "Suzu Agent Core 启动超时");
  const stopTimeout = normalizePositiveInteger(stopTimeoutMs, 5_000, "Suzu Agent Core 停止超时");
  const rpcTimeout = normalizePositiveInteger(requestTimeoutMs, DEFAULT_RPC_TIMEOUT_MS, "Suzu Agent Core 请求超时");
  const extraEnvironment = plainObject(environment);
  const patches = patchFileList(patchFiles);
  const packagedNativeRuntimeRoot = isAbsolute(clean(resourcesPath))
    ? join(resolve(resourcesPath), "agent-core-native", "node_modules")
    : "";

  const listeners = new Set();
  const lifecycleListeners = new Set();
  const pendingLifecycleCommands = new Map();
  let state = "stopped";
  let current = null;
  let startTask = null;
  let closing = false;
  let lifecycleCommandSequence = 0;

  const snapshot = () => Object.freeze({
    state,
    endpoint: "",
    transport: "node-ipc",
    pid: Number.isInteger(current?.child?.pid) ? current.child.pid : null,
    runtimeHome: home,
  });
  const publish = (type, details = {}) => {
    const event = Object.freeze({ type, ...snapshot(), details: plainObject(details) });
    for (const listener of listeners) {
      try { listener(event); } catch { /* Observers cannot break child ownership. */ }
    }
  };
  const settleLifecycleCommand = (requestId, value) => {
    const record = pendingLifecycleCommands.get(clean(requestId));
    if (!record) return false;
    pendingLifecycleCommands.delete(record.requestId);
    clearTimeout(record.timer);
    record.resolve(Object.freeze(value));
    return true;
  };
  const settleAllLifecycleCommands = (reason) => {
    for (const requestId of [...pendingLifecycleCommands.keys()]) settleLifecycleCommand(requestId, { available: false, reason });
  };
  const publishLifecycle = (value) => {
    const message = normalizeSuzuAgentLifecycleIpcMessage(value);
    if (!message) return false;
    if (message.kind === "response" && settleLifecycleCommand(message.requestId, { available: true, result: message.result })) return true;
    for (const listener of lifecycleListeners) {
      try { listener(message); } catch { /* A lifecycle observer cannot break the host. */ }
    }
    return true;
  };
  const settlePendingRequest = (record, message) => {
    const pending = record.pendingRequests.get(validRequestId(message.requestId));
    if (!pending) return false;
    record.pendingRequests.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.resolve({ result: message.result });
    return true;
  };
  const failPendingRequests = (record, error) => {
    for (const pending of record.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    record.pendingRequests.clear();
  };
  const closeEventStreams = (record, error) => {
    for (const subscribers of Object.values(record.eventSubscribers)) {
      for (const subscriber of [...subscribers]) subscriber.end(error);
      subscribers.clear();
    }
  };
  const handleHostMessage = (record, raw) => {
    if (publishLifecycle(raw)) return;
    const message = normalizeSuzuAgentHostIpcMessage(raw);
    if (!message) return;
    if (message.kind === "ready") record.ready.resolve(message.details);
    else if (message.kind === "response") settlePendingRequest(record, message);
    else if (message.kind === "event") {
      for (const subscriber of record.eventSubscribers[message.channel]) subscriber.push(message.envelope);
    }
  };
  const settle = (record, outcome) => {
    if (record.outcome) return;
    record.outcome = outcome;
    const unavailable = new SuzuAgentRuntimeError("AGENT_CORE_EXITED", childExitMessage(outcome));
    record.ready.reject(unavailable);
    failPendingRequests(record, unavailable);
    closeEventStreams(record, unavailable);
    record.resolveExit(outcome);
    settleAllLifecycleCommands("child-exited");
    if (current !== record) return;
    current = null;
    state = "stopped";
    publish(record.stopping || closing ? "stopped" : "exited", { reason: record.stopping || closing ? "requested" : childExitMessage(outcome) });
  };
  const stopRecord = async (record) => {
    if (!record || record.outcome) return record?.outcome;
    record.stopping = true;
    try { record.child.kill(); } catch { /* Exit watcher owns the final state. */ }
    const elapsed = await Promise.race([record.exitPromise, wait(stopTimeout).then(() => null)]);
    if (elapsed) return elapsed;
    try { record.child.kill("SIGKILL"); } catch { /* Best effort for an owned child only. */ }
    const forced = await Promise.race([record.exitPromise, wait(stopTimeout).then(() => null)]);
    if (forced) return forced;
    throw new SuzuAgentRuntimeError("AGENT_CORE_STOP_TIMEOUT", "Suzu Agent Core 子进程未能在超时内停止。 ");
  };
  const waitForReady = async (record) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new SuzuAgentRuntimeError("AGENT_CORE_START_TIMEOUT", `Suzu Agent Core 在 ${startupTimeout}ms 内没有就绪。`)),
        startupTimeout,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([record.ready.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (record.outcome) throw new SuzuAgentRuntimeError("AGENT_CORE_EXITED", childExitMessage(record.outcome));
    const response = await record.api.host.describe({});
    const error = rpcErrorMessage(response);
    if (error) throw new SuzuAgentRuntimeError("AGENT_CORE_DESCRIBE_REJECTED", error);
    return plainObject(plainObject(response).result).value;
  };
  const launch = async () => {
    state = "starting";
    publish("starting");
    if (closing) {
      state = "stopped";
      throw new SuzuAgentRuntimeError("AGENT_CORE_START_CANCELLED", "Suzu Agent Core 启动已被停止请求取消。 ");
    }
    const childEnvironment = {
      ...process.env,
      ...extraEnvironment,
      // Product-owned child settings.
      SUZU_AGENT_HOME: home,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      npm_config_cache: join(temp, "npm-cache"),
      NPM_CONFIG_CACHE: join(temp, "npm-cache"),
      ...(packagedNativeRuntimeRoot ? { SUZU_AGENT_CORE_NATIVE_ROOT: packagedNativeRuntimeRoot } : {}),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };
    // Suzu Core owns its storage and does not adopt configuration from a
    // separately installed DSH. Removing inherited legacy keys also makes a
    // future vendor update unable to silently cross this product boundary.
    for (const key of Object.keys(childEnvironment)) {
      if (key.toUpperCase().startsWith("DSH_")) delete childEnvironment[key];
    }
    let child;
    try {
      child = spawnImpl(executable, [
        "--experimental-loader",
        pathToFileURL(loader).href,
        host,
        ...patches.flatMap((file) => ["--patch", file]),
      ], { cwd: workspace, env: childEnvironment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, shell: false });
    } catch (error) {
      state = "stopped";
      throw new SuzuAgentRuntimeError("AGENT_CORE_SPAWN_FAILED", "无法启动 Suzu Agent Core 进程。", { cause: error });
    }
    if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
      state = "stopped";
      throw new SuzuAgentRuntimeError("AGENT_CORE_SPAWN_FAILED", "Suzu Agent Core 进程启动器返回了无效子进程。 ");
    }
    let resolveExit;
    const ready = deferred();
    // Avoid an unhandled rejection if a stop races startup before the startup
    // promise has had a chance to observe this deferred value.
    ready.promise.catch(() => undefined);
    const record = {
      child,
      api: null,
      ready,
      stopping: false,
      outcome: null,
      pendingRequests: new Map(),
      eventSubscribers: { mux: new Set(), host: new Set() },
      exitPromise: new Promise((resolveExitPromise) => { resolveExit = resolveExitPromise; }),
      resolveExit,
      readStdout: attachOutputTail(child.stdout),
      readStderr: attachOutputTail(child.stderr),
    };
    record.api = createAgentCoreApi(record, { requestTimeoutMs: rpcTimeout });
    current = record;
    child.on?.("message", (message) => handleHostMessage(record, message));
    child.once("exit", (code, signal) => settle(record, { code, signal }));
    child.once("error", (error) => settle(record, { error }));
    try {
      const describe = await waitForReady(record);
      if (record.outcome) throw new SuzuAgentRuntimeError("AGENT_CORE_EXITED", childExitMessage(record.outcome));
      if (closing) throw new SuzuAgentRuntimeError("AGENT_CORE_START_CANCELLED", "Suzu Agent Core 启动已被停止请求取消。 ");
      state = "ready";
      publish("ready", { describe });
      return Object.freeze({ endpoint: "", transport: "node-ipc", pid: Number.isInteger(child.pid) ? child.pid : null, api: record.api, describe });
    } catch (error) {
      await stopRecord(record);
      if (current === record) current = null;
      state = "stopped";
      publish("failed", { code: error?.code || "AGENT_CORE_START_FAILED" });
      throw startupFailure(error, record.readStderr());
    }
  };
  const start = async () => {
    if (state === "ready" && current) {
      return Object.freeze({ endpoint: "", transport: "node-ipc", pid: Number.isInteger(current.child.pid) ? current.child.pid : null, api: current.api, describe: undefined });
    }
    if (startTask) return startTask;
    closing = false;
    startTask = launch().finally(() => { startTask = null; });
    return startTask;
  };
  const stop = async () => {
    closing = true;
    if (current) await stopRecord(current);
    if (startTask) {
      try { await startTask; } catch { /* Stop during startup expects startup to fail. */ }
    }
    if (current) throw new SuzuAgentRuntimeError("AGENT_CORE_STOP_TIMEOUT", "Suzu Agent Core 子进程仍在运行，不能假装已停止。 ");
    state = "stopped";
    return snapshot();
  };
  return Object.freeze({
    start,
    stop,
    async restart() { await stop(); return start(); },
    status() { return snapshot(); },
    subscribe(listener) {
      if (typeof listener !== "function") throw new SuzuAgentRuntimeError("INVALID_LISTENER", "Suzu Agent Core 监管器订阅者无效。 ");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeLifecycle(listener) {
      if (typeof listener !== "function") throw new SuzuAgentRuntimeError("INVALID_LISTENER", "Suzu Agent 生命周期订阅者无效。 ");
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    respondLifecycleRequest({ requestId, result = {} } = {}) {
      const id = clean(requestId);
      if (!id || id.length > 256 || /[\r\n\0]/u.test(id)) throw new SuzuAgentRuntimeError("INVALID_LIFECYCLE_REQUEST", "Suzu Agent 生命周期请求标识无效。 ");
      const child = current?.child;
      if (!child || child.connected === false || typeof child.send !== "function") return false;
      try {
        child.send({ protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL, kind: "response", requestId: id, result: plainObject(result) });
        return true;
      } catch {
        return false;
      }
    },
    requestLifecycleCommand({ event, payload = {}, timeoutMs = 120_000 } = {}) {
      const name = clean(event);
      if (!name || name.length > 128 || /[\r\n\0]/u.test(name)) throw new SuzuAgentRuntimeError("INVALID_LIFECYCLE_COMMAND", "Suzu Agent 产品命令无效。 ");
      const timeout = normalizePositiveInteger(timeoutMs, 120_000, "Suzu Agent 产品命令超时");
      if (timeout > 180_000) throw new SuzuAgentRuntimeError("INVALID_TIMEOUT", "Suzu Agent 产品命令超时不能超过 180000ms。 ");
      const child = current?.child;
      if (!child || child.connected === false || typeof child.send !== "function") return Promise.resolve(Object.freeze({ available: false, reason: "unavailable" }));
      const requestId = `suzu-command-${child.pid || "agent"}-${Date.now()}-${++lifecycleCommandSequence}`;
      return new Promise((resolveCommand) => {
        const timer = setTimeout(() => settleLifecycleCommand(requestId, { available: false, reason: "timeout" }), timeout);
        timer.unref?.();
        pendingLifecycleCommands.set(requestId, { requestId, resolve: resolveCommand, timer });
        try {
          child.send({ protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL, kind: "command", requestId, event: name, payload: plainObject(payload) });
        } catch {
          settleLifecycleCommand(requestId, { available: false, reason: "unavailable" });
        }
      });
    },
  });
}
